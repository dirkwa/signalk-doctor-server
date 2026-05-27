import { getSignalkAdminToken, invalidateSignalkAdminTokenCache } from './signalk-token.js';
import { signalkHttpUrl } from '../probes/signalk-url.js';

// Same HTTP endpoint the signalk-health probe uses; we strip the
// `/signalk` suffix because the diagnostics route lives under `/skServer`.
function signalkBase(): string {
  return signalkHttpUrl().replace(/\/signalk\/?$/, '');
}

export interface InstalledPackage {
  name: string;
  version: string;
}

/** Mirror of signalk-server's Diagnostics envelope — an object with a
 *  `packages` array of {name, version}. The envelope shape leaves room
 *  for sibling diagnostic fields (runtime info, memory, etc.) to land
 *  without new endpoints, mirroring the upstream contract added in
 *  SignalK/signalk-server#2702. */
export interface Diagnostics {
  packages: InstalledPackage[];
}

export type DiagnosticsReason =
  /** Doctor has no admin token at /data/signalk-token. The installer
   *  is supposed to provision it; see signalk-universal-installer's
   *  step 15b. */
  | 'no-token'
  /** signalk-server returned 401/403 — token is bad or stale. The
   *  token cache has been invalidated so the next scan re-reads from
   *  disk; if that doesn't help, the operator must regenerate. */
  | 'auth'
  /** TCP-level failure (signalk-server down, DNS, AbortError on
   *  timeout). Operator should check the Health tab's signalk-server
   *  probe. */
  | 'network'
  /** signalk-server returned 404 — running an image that predates
   *  SignalK PR #2702. Operator needs to upgrade signalk-server. */
  | 'not-found'
  /** Other non-2xx (5xx, etc.). Generic "something on the server is
   *  broken" — surface stderr for the operator to dig in. */
  | 'http'
  /** Response wasn't an object or had no `packages` array. Most
   *  likely the route was claimed by a different handler returning a
   *  legacy shape, or the diagnostics PR's envelope changed. */
  | 'bad-payload';

export type DiagnosticsResult =
  | { ok: true; diagnostics: Diagnostics }
  | { ok: false; reason: DiagnosticsReason; detail: string };

export async function fetchDiagnostics(): Promise<DiagnosticsResult> {
  const token = await getSignalkAdminToken();
  if (!token) {
    return {
      ok: false,
      reason: 'no-token',
      detail: 'signalk admin token not provisioned at /data/signalk-token',
    };
  }

  const url = `${signalkBase()}/skServer/diagnostics`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      // Token may have been rotated; drop the cache so the next scan picks up a fresh one.
      invalidateSignalkAdminTokenCache();
      return { ok: false, reason: 'auth', detail: `HTTP ${res.status} from ${url}` };
    }
    if (res.status === 404) {
      // The /skServer/diagnostics endpoint landed in SignalK PR #2702;
      // older signalk-server images don't have it. Distinguish from
      // generic HTTP errors so the UI can guide the operator to
      // upgrade signalk-server rather than chase a phantom 5xx.
      return { ok: false, reason: 'not-found', detail: `HTTP 404 from ${url}` };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http', detail: `HTTP ${res.status} from ${url}` };
    }
    const body = (await res.json()) as { packages?: unknown } | null;
    if (!body || typeof body !== 'object') {
      return { ok: false, reason: 'bad-payload', detail: 'response is not a JSON object' };
    }
    if (!Array.isArray(body.packages)) {
      return { ok: false, reason: 'bad-payload', detail: 'response missing `packages` array' };
    }
    const packages: InstalledPackage[] = [];
    for (const entry of body.packages) {
      if (
        entry &&
        typeof entry === 'object' &&
        'name' in entry &&
        'version' in entry &&
        typeof (entry as { name: unknown }).name === 'string' &&
        typeof (entry as { version: unknown }).version === 'string'
      ) {
        const e = entry as { name: string; version: string };
        packages.push({ name: e.name, version: e.version });
      }
    }
    return { ok: true, diagnostics: { packages } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'network', detail: msg };
  } finally {
    clearTimeout(timer);
  }
}
