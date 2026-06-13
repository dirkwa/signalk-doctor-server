import type { ProbeResult } from './types.js';

// Same reasoning as signalk-health.ts: 127.0.0.1 is the doctor's own
// container, not the host. Reach the updater via Podman's host gateway.
const UPDATER_URL = process.env.UPDATER_URL ?? 'http://host.containers.internal:3003/api/health';

// Per-attempt abort. Kept at 5s — raising it would mask slowness and slow a
// genuine-down verdict; the slow case is handled by the warn tier below, not
// by a longer timeout.
const TIMEOUT_MS = 5000;
// Reachable but slower than this ⇒ warn "likely disk I/O". Observed healthy is
// ~12ms; an SD-card-starved doctor answered in 2700–3800ms. 1.5s sits well
// above healthy and below the abort. Mirrors signalk-health.ts SLOW_MS.
const SLOW_MS = 1500;
// Bounded retry so a single slow/missed answer (the doctor↔updater pasta
// sibling path has the least headroom and is first to stall under load)
// doesn't flap the probe to fail. Shorter than the installer's 180s startup
// gate — this runs on every /api/probes call.
const RETRIES = 2;
const RETRY_DELAY_MS = 1500;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchHealthOnce(): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(UPDATER_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeUpdaterHealth(): Promise<ProbeResult> {
  const t0 = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await delay(RETRY_DELAY_MS);
    // Time the slow check against THIS attempt, not t0 — t0 includes failed
    // attempts and their retry delays, which would mislabel a fast success
    // after a transient failure as "slow I/O". durationMs still reports total.
    const attemptStart = Date.now();
    try {
      const res = await fetchHealthOnce();
      if (!res.ok) {
        return {
          id: 'updater-health',
          label: 'Updater HTTP health',
          status: 'fail',
          message: `HTTP ${res.status} from ${UPDATER_URL}`,
          durationMs: Date.now() - t0,
        };
      }
      const body = (await res.json()) as { ok?: boolean; runtime?: string };
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
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return {
    id: 'updater-health',
    label: 'Updater HTTP health',
    status: 'fail',
    message: `cannot reach ${UPDATER_URL}: ${msg}`,
    durationMs: Date.now() - t0,
  };
}
