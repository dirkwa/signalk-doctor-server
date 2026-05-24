// We hit the package abbreviated metadata endpoint `/<pkg>/latest` — it's
// orders of magnitude smaller than the full package document, and the
// registry serves it through Cloudflare with strong ETags.
const NPM_REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org';

const FETCH_TIMEOUT_MS = 5000;

export type NpmRegistryResult =
  | { kind: 'fetched'; version: string; etag: string | null }
  | { kind: 'not-modified'; etag: string }
  | { kind: 'offline'; detail: string }
  | { kind: 'error'; detail: string };

export async function getLatestVersion(
  packageName: string,
  previousEtag: string | null,
): Promise<NpmRegistryResult> {
  // Scoped packages need URL-encoding because of the leading `@`/`/`.
  const url = `${NPM_REGISTRY}/${encodeURIComponent(packageName).replace('%40', '@')}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (previousEtag) headers['If-None-Match'] = previousEtag;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (res.status === 304) {
      return { kind: 'not-modified', etag: previousEtag ?? '' };
    }
    if (!res.ok) {
      return { kind: 'error', detail: `HTTP ${res.status} from ${url}` };
    }
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== 'string') {
      return { kind: 'error', detail: 'response missing `version`' };
    }
    return { kind: 'fetched', version: body.version, etag: res.headers.get('etag') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // ENOTFOUND / ETIMEDOUT / AbortError all mean "the boat probably has no
    // internet right now" — treat as offline, not as a hard failure.
    return { kind: 'offline', detail: msg };
  } finally {
    clearTimeout(timer);
  }
}
