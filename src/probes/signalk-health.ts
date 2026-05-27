import { Agent } from 'undici';
import type { ProbeResult } from './types.js';
import { signalkHttpUrl, signalkHttpsUrl } from './signalk-url.js';

const ID = 'signalk-health';
const LABEL = 'SignalK server HTTP health';
const TIMEOUT_MS = 5000;

// signalk-server, with SSL on, serves HTTPS on `sslport` using a
// self-signed leaf (the local CA minted by signalk-ssl). The doctor's
// HTTPS health hop is an internal host-gateway call, not a browser, so
// we deliberately don't verify that cert — verifying it would require
// shipping the boat's CA into this container for no security gain. This
// relaxation is scoped to this one probe's HTTPS fallback; nothing else
// in the engine uses it.
const insecureTls = new Agent({ connect: { rejectUnauthorized: false } });

function ok(message: string, t0: number): ProbeResult {
  return { id: ID, label: LABEL, status: 'ok', message, durationMs: Date.now() - t0 };
}
function fail(message: string, t0: number): ProbeResult {
  return { id: ID, label: LABEL, status: 'fail', message, durationMs: Date.now() - t0 };
}

/** One fetch hop with a 5s timeout. `manualRedirect` keeps signalk-server's
 *  HTTP→HTTPS 302 observable instead of auto-following it into the
 *  self-signed HTTPS handshake. `tlsRelaxed` uses the insecure dispatcher
 *  for the HTTPS hop. */
async function hop(
  url: string,
  opts: { manualRedirect?: boolean; tlsRelaxed?: boolean },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // `dispatcher` is undici's; the global fetch types it via @types/node's
  // bundled undici-types, a different (older) copy than the `undici`
  // package we import `Agent` from, so the two Dispatcher identities
  // don't unify. Derive the init type from fetch itself and cast the
  // Agent across the seam. Runtime is fine — fastify pulls the same
  // undici@8, and Node's fetch honours `dispatcher`.
  type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
  const init: FetchInit = {
    signal: controller.signal,
    redirect: opts.manualRedirect ? 'manual' : 'follow',
  };
  if (opts.tlsRelaxed) init.dispatcher = insecureTls as unknown as FetchInit['dispatcher'];
  try {
    return await fetch(url, init);
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
  const httpUrl = signalkHttpUrl();
  const httpsUrl = signalkHttpsUrl();

  let httpErr: unknown;
  try {
    const res = await hop(httpUrl, { manualRedirect: true });

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
      return await probeHttps(httpsUrl, t0, 'redirect');
    }

    // Server is up but unhealthy (5xx, etc.) — surface it; don't mask
    // a real error by falling through to HTTPS.
    return fail(`HTTP ${res.status} from ${httpUrl}`, t0);
  } catch (err) {
    // HTTP listener unreachable. Could be signalk-server down, or an
    // exotic config where only HTTPS is up — try HTTPS as a last resort.
    httpErr = err;
  }

  if (httpsUrl) {
    const viaHttps = await probeHttps(httpsUrl, t0, 'fallback');
    if (viaHttps.status === 'ok') return viaHttps;
  }

  const msg = httpErr instanceof Error ? httpErr.message : String(httpErr);
  const tried = httpsUrl ? `${httpUrl} or ${httpsUrl}` : httpUrl;
  return fail(`cannot reach signalk-server on ${tried}: ${msg}`, t0);
}

/** Fetch the HTTPS endpoint with TLS verification relaxed. `reason`
 *  shapes the success message: a redirect from :80 (SSL confirmed) vs a
 *  last-resort fallback after HTTP refused. */
async function probeHttps(
  httpsUrl: string,
  t0: number,
  reason: 'redirect' | 'fallback',
): Promise<ProbeResult> {
  try {
    const res = await hop(httpsUrl, { tlsRelaxed: true });
    if (res.ok) {
      const note =
        reason === 'redirect' ? ' (SSL enabled, redirected from HTTP)' : ' (SSL enabled)';
      return ok(`HTTP ${res.status} from ${httpsUrl}${note}`, t0);
    }
    return fail(`HTTP ${res.status} from ${httpsUrl}`, t0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`cannot reach ${httpsUrl}: ${msg}`, t0);
  }
}
