import { Agent } from 'undici';
import type { ProbeResult } from './types.js';
import { signalkHttpUrl, signalkHttpsUrl } from './signalk-url.js';
import { MIN_HOP_MS, startProbeDeadline, type ProbeDeadline } from './budget.js';
import { describeFetchError } from './fetch-error.js';

const ID = 'signalk-health';
const LABEL = 'SignalK server HTTP health';
// What one hop asks for. It is a ceiling, not a reservation: this probe can
// make two sequential hops (HTTP, then HTTPS) and two full helpings would
// overrun the runner's per-probe budget, so each hop takes the smaller of
// this and whatever the budget has left. Before that clamp existed, an
// unreachable host gateway spent 5s on HTTP and 5s on HTTPS and the runner
// killed the probe at 8s, replacing `cannot reach …` with `timed out`.
const HOP_TIMEOUT_MS = 5000;
// Reachable but slower than this ⇒ warn "likely disk I/O" rather than a bare
// ok. Mirrors updater-health.ts SLOW_MS. signalk-server runs Network=host so
// this is the fast path with the most headroom; it still flags I/O stalls.
// Raised to 4s so a busy-but-functional box isn't flagged on every run while
// the warn band (4s–TIMEOUT_MS) still catches a genuinely wedged server.
const SLOW_MS = 4000;

// signalk-server, with SSL on, serves HTTPS on `sslport` using a
// self-signed leaf (the local CA minted by signalk-ssl). The doctor's
// HTTPS health hop is an internal host-gateway call, not a browser, so
// we deliberately don't verify that cert — verifying it would require
// shipping the boat's CA into this container for no security gain. This
// relaxation is scoped to this one probe's HTTPS fallback; nothing else
// in the engine uses it.
const insecureTls = new Agent({ connect: { rejectUnauthorized: false } });

function ok(message: string, t0: number): ProbeResult {
  const durationMs = Date.now() - t0;
  // A reachable-but-slow signalk-server is the same I/O-contention signal the
  // updater-health and storage-type probes surface — downgrade to warn so it
  // doesn't read as a clean bill of health.
  if (durationMs > SLOW_MS) {
    return {
      id: ID,
      label: LABEL,
      status: 'warn',
      message: `${message} — slow (${durationMs}ms); likely host I/O contention, see the Host root storage probe`,
      durationMs,
    };
  }
  return { id: ID, label: LABEL, status: 'ok', message, durationMs };
}
function fail(message: string, t0: number): ProbeResult {
  return { id: ID, label: LABEL, status: 'fail', message, durationMs: Date.now() - t0 };
}

/** One fetch hop, bounded by `timeoutMs` (the budget-clamped hop allowance).
 *  `manualRedirect` keeps signalk-server's HTTP→HTTPS 302 observable instead
 *  of auto-following it into the self-signed HTTPS handshake. `tlsRelaxed`
 *  uses the insecure dispatcher for the HTTPS hop. Rejects with an
 *  operator-readable message rather than undici's `fetch failed`. */
async function hop(
  url: string,
  opts: { manualRedirect?: boolean; tlsRelaxed?: boolean },
  timeoutMs: number,
): Promise<Response> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // `dispatcher` is undici's; the global fetch types it via @types/node's
  // bundled undici-types, a different copy than the `undici` package we
  // import `Agent` from, so the two Dispatcher identities don't unify.
  // Derive the init type from fetch itself and cast the Agent across the
  // seam. The external undici major must match Node's bundled undici
  // (process.versions.undici), otherwise Node's bundled fetch rejects
  // the external Agent with `InvalidArgumentError: invalid onRequestStart
  // method` — Node 24 bundles undici 7.x, so we pin `^7.26.0`.
  type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
  const init: FetchInit = {
    signal: controller.signal,
    redirect: opts.manualRedirect ? 'manual' : 'follow',
  };
  if (opts.tlsRelaxed) init.dispatcher = insecureTls as unknown as FetchInit['dispatcher'];
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(describeFetchError(err, Date.now() - started), { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/** A 3xx, or the `opaqueredirect` (status 0) that `redirect: 'manual'`
 *  yields, both mean signalk-server is redirecting HTTP → HTTPS — i.e.
 *  SSL is enabled. */
function isRedirect(res: Response): boolean {
  return res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
}

export async function probeSignalkHealth(): Promise<ProbeResult> {
  const t0 = Date.now();
  const deadline = startProbeDeadline();
  const httpUrl = signalkHttpUrl();
  const httpsUrl = signalkHttpsUrl();

  let httpErr: string;
  try {
    const res = await hop(httpUrl, { manualRedirect: true }, deadline.hop(HOP_TIMEOUT_MS));

    if (res.ok) {
      // SSL off: signalk-server answers directly on HTTP.
      return ok(`HTTP ${res.status} from ${httpUrl}`, t0);
    }

    if (isRedirect(res)) {
      // SSL on: HTTP port 302-redirects to HTTPS. Follow to the HTTPS
      // endpoint the installer injected and report on that.
      if (!httpsUrl) {
        return fail(
          `${httpUrl} redirects to HTTPS (SSL enabled) but no SIGNALK_HTTPS_URL is configured`,
          t0,
        );
      }
      if (!deadline.allows(MIN_HOP_MS)) {
        return fail(
          `${httpUrl} redirects to ${httpsUrl} (SSL enabled) but no probe budget remained to check it`,
          t0,
        );
      }
      return (await probeHttps(httpsUrl, t0, 'redirect', deadline)).result;
    }

    // Server is up but unhealthy (5xx, etc.) — surface it; don't mask
    // a real error by falling through to HTTPS.
    return fail(`HTTP ${res.status} from ${httpUrl}`, t0);
  } catch (err) {
    // HTTP listener unreachable. Could be signalk-server down, or an
    // exotic config where only HTTPS is up — try HTTPS as a last resort.
    httpErr = err instanceof Error ? err.message : String(err);
  }

  // Only attempt the fallback while a hop long enough to be meaningful still
  // fits: spending the last few hundred ms on a hop that must abort would
  // report a self-inflicted timeout in place of the real HTTP error above.
  const httpsAttempted = httpsUrl !== null && deadline.allows(MIN_HOP_MS);
  if (httpsUrl && httpsAttempted) {
    const viaHttps = await probeHttps(httpsUrl, t0, 'fallback', deadline);
    // HTTPS answered: report it — ok, or a reachable-but-unhealthy
    // status that's more informative than the HTTP-refused error below.
    if (viaHttps.reachable) return viaHttps.result;
  }

  const tried = httpsAttempted ? `${httpUrl} or ${httpsUrl}` : httpUrl;
  const skipped =
    httpsUrl && !httpsAttempted ? ` (HTTPS fallback to ${httpsUrl} skipped, no budget left)` : '';
  return fail(`cannot reach signalk-server on ${tried}: ${httpErr}${skipped}`, t0);
}

/** Fetch the HTTPS endpoint with TLS verification relaxed. `reason`
 *  shapes the success message: a redirect from :80 (SSL confirmed) vs a
 *  last-resort fallback after HTTP refused. `reachable` reports whether
 *  HTTPS answered at all (any status) vs the fetch throwing, so the
 *  fallback caller can prefer a reachable-but-unhealthy HTTPS result
 *  over a bare HTTP-refused message. */
async function probeHttps(
  httpsUrl: string,
  t0: number,
  reason: 'redirect' | 'fallback',
  deadline: ProbeDeadline,
): Promise<{ result: ProbeResult; reachable: boolean }> {
  try {
    const res = await hop(httpsUrl, { tlsRelaxed: true }, deadline.hop(HOP_TIMEOUT_MS));
    if (res.ok) {
      const note =
        reason === 'redirect' ? ' (SSL enabled, redirected from HTTP)' : ' (SSL enabled)';
      return { result: ok(`HTTP ${res.status} from ${httpsUrl}${note}`, t0), reachable: true };
    }
    return { result: fail(`HTTP ${res.status} from ${httpsUrl}`, t0), reachable: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: fail(`cannot reach ${httpsUrl}: ${msg}`, t0), reachable: false };
  }
}
