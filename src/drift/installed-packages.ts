import { getSignalkAdminToken, invalidateSignalkAdminTokenCache } from './signalk-token.js';

// Same env override the existing signalk-health probe uses; we strip the
// `/signalk` suffix because the new admin route lives under `/skServer`.
function signalkBase(): string {
  const url = process.env.SIGNALK_URL ?? 'http://host.containers.internal:3000/signalk';
  return url.replace(/\/signalk\/?$/, '');
}

export interface InstalledPackage {
  name: string;
  version: string;
}

export type InstalledPackagesResult =
  | { ok: true; packages: InstalledPackage[] }
  | { ok: false; reason: 'no-token' | 'auth' | 'network' | 'http' | 'bad-payload'; detail: string };

export async function fetchInstalledPackages(): Promise<InstalledPackagesResult> {
  const token = await getSignalkAdminToken();
  if (!token) {
    return {
      ok: false,
      reason: 'no-token',
      detail: 'signalk admin token not provisioned at /data/signalk-token',
    };
  }

  const url = `${signalkBase()}/skServer/installedPackages`;
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
    const body = (await res.json()) as { packages?: unknown };
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
    return { ok: true, packages };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'network', detail: msg };
  } finally {
    clearTimeout(timer);
  }
}
