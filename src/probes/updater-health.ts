import type { ProbeResult } from './types.js';
import { MIN_HOP_MS, startProbeDeadline } from './budget.js';
import { describeFetchError } from './fetch-error.js';

// Same reasoning as signalk-health.ts: 127.0.0.1 is the doctor's own
// container, not the host. Reach the updater via Podman's host gateway.
const UPDATER_URL = process.env.UPDATER_URL ?? 'http://host.containers.internal:3003/api/health';

// Per-attempt abort. Kept at 5s — raising it would mask slowness and slow a
// genuine-down verdict; the slow case is handled by the warn tier below, not
// by a longer timeout.
const TIMEOUT_MS = 5000;
// Reachable but slower than this ⇒ warn "likely disk I/O". Observed healthy is
// ~12ms; an SD-card-starved doctor answered in 2700–3800ms. Raised to 4s so a
// busy-but-functional box (a localhost call that lands in the low seconds) is
// not flagged on every run; the warn band (4s–TIMEOUT_MS) still catches a
// genuinely wedged server before the abort fails it. Mirrors
// signalk-health.ts SLOW_MS.
const SLOW_MS = 4000;
// Bounded retry so a single slow/missed answer (the doctor↔updater pasta
// sibling path has the least headroom and is first to stall under load)
// doesn't flap the probe to fail. Shorter than the installer's 180s startup
// gate — this runs on every /api/probes call.
//
// RETRIES is an upper bound, not a promise: three 5s attempts plus their
// backoffs sum to 18s, far past the runner's per-probe budget, and a probe the
// runner kills has its verdict thrown away and replaced with a bare
// "timed out". So the ladder also stops the moment the budget can no longer
// fund a meaningful attempt — a real `cannot reach …` beats a retry we cannot
// afford to finish.
const RETRIES = 2;
const RETRY_DELAY_MS = 1500;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface UpdaterHealthBody {
  ok?: boolean;
  runtime?: string;
}

/** One attempt, headers AND body inside the same abort timer.
 *
 *  Reading the body after the timer is cleared would leave the slowest part of
 *  the request unbounded: an updater that sends headers and then stalls its
 *  body (the shape a wedged event loop or a half-open route produces) would
 *  hang the probe past the runner's ceiling, and the runner discards an
 *  overrunning probe's verdict — the exact failure this budget exists to
 *  prevent. So the timeout has to span the whole exchange, not just the
 *  handshake. Returns the parsed body; the caller never touches the stream. */
async function fetchHealthOnce(
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: UpdaterHealthBody }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(UPDATER_URL, { signal: controller.signal });
    // Don't spend the budget parsing a body we're going to discard: a non-2xx
    // is reported by status alone, and its body may be the thing that stalls.
    if (!res.ok) return { ok: false, status: res.status, body: {} };
    return { ok: true, status: res.status, body: (await res.json()) as UpdaterHealthBody };
  } catch (err) {
    throw new Error(describeFetchError(err, Date.now() - started), { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeUpdaterHealth(): Promise<ProbeResult> {
  const t0 = Date.now();
  const deadline = startProbeDeadline();
  let lastErr: unknown;
  let attempts = 0;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await delay(RETRY_DELAY_MS);
    attempts++;
    // Time the slow check against THIS attempt, not t0 — t0 includes failed
    // attempts and their retry delays, which would mislabel a fast success
    // after a transient failure as "slow I/O". durationMs still reports total.
    const attemptStart = Date.now();
    try {
      const res = await fetchHealthOnce(deadline.hop(TIMEOUT_MS));
      if (!res.ok) {
        return {
          id: 'updater-health',
          label: 'Updater HTTP health',
          status: 'fail',
          message: `HTTP ${res.status} from ${UPDATER_URL}`,
          durationMs: Date.now() - t0,
        };
      }
      const body = res.body;
      const attemptMs = Date.now() - attemptStart;
      const totalMs = Date.now() - t0;
      const runtimeNote = body.runtime ? ` (runtime=${body.runtime})` : '';
      if (!body.ok) {
        const okState = body.ok === false ? 'ok=false' : 'no ok field';
        return {
          id: 'updater-health',
          label: 'Updater HTTP health',
          status: 'warn',
          message: `Updater reachable but reports ${okState}${runtimeNote}`,
          details: body as Record<string, unknown>,
          durationMs: totalMs,
        };
      }
      // Reachable and healthy — but flag a slow response, the signature of
      // host I/O contention (see the storage-type probe; usually an SD card).
      const slow = attemptMs > SLOW_MS;
      return {
        id: 'updater-health',
        label: 'Updater HTTP health',
        status: slow ? 'warn' : 'ok',
        message: slow
          ? `Updater reachable but slow (${attemptMs}ms) — likely host I/O contention; see the Host root storage probe`
          : `Updater reports OK${runtimeNote}`,
        details: body as Record<string, unknown>,
        durationMs: totalMs,
      };
    } catch (err) {
      lastErr = err;
    }
    // Retry only while the budget can still fund the backoff AND a hop long
    // enough to mean something; otherwise stop and report the error we have.
    if (!deadline.allows(RETRY_DELAY_MS + MIN_HOP_MS)) break;
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const tries = attempts > 1 ? ` (${attempts} attempts)` : '';
  return {
    id: 'updater-health',
    label: 'Updater HTTP health',
    status: 'fail',
    message: `cannot reach ${UPDATER_URL}: ${msg}${tries}`,
    durationMs: Date.now() - t0,
  };
}
