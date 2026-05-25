import { getSignalkAdminToken, invalidateSignalkAdminTokenCache } from './signalk-token.js';

// Same env override the existing signalk-health probe uses; we strip the
// `/signalk` suffix because the diagnostics route lives under `/skServer`.
function signalkBase(): string {
  const url = process.env.SIGNALK_URL ?? 'http://host.containers.internal:3000/signalk';
  return url.replace(/\/signalk\/?$/, '');
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

export type DiagnosticsResult =
  | { ok: true; diagnostics: Diagnostics }
  | { ok: false; reason: 'no-token' | 'auth' | 'network' | 'http' | 'bad-payload'; detail: string };

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
