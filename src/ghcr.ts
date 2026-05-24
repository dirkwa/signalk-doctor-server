import type { Tag } from './types.js';
import { classifyChannel } from './tagClassifier.js';
import { categorizeError, type CategorizedError } from './errors.js';

interface CacheEntry {
  tags: Tag[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 6 * 60 * 60 * 1000;

interface TagsListResponse {
  name: string;
  tags?: string[];
}

interface ManifestResponse {
  config?: { digest?: string };
  schemaVersion?: number;
}

async function getAnonToken(image: string): Promise<string | null> {
  const url = `https://ghcr.io/token?scope=repository:${image}:pull&service=ghcr.io`;
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch {
    return null;
  }
}

async function fetchTagList(image: string, token: string): Promise<string[]> {
  const all: string[] = [];
  let url: string | null = `https://ghcr.io/v2/${image}/tags/list?n=100`;
  while (url) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`tags/list: HTTP ${res.status}`);
    const body = (await res.json()) as TagsListResponse;
    if (body.tags) all.push(...body.tags);
    const link: string | null = res.headers.get('link');
    if (link && /rel="?next"?/i.test(link)) {
      const m = link.match(/<([^>]+)>/);
      url = m && m[1] ? new URL(m[1], 'https://ghcr.io').toString() : null;
    } else {
      url = null;
    }
  }
  return all;
}

async function fetchManifestDigest(
  image: string,
  tag: string,
  token: string,
): Promise<{ digest: string; size: number; pushedAt: string }> {
  const res = await fetch(`https://ghcr.io/v2/${image}/manifests/${encodeURIComponent(tag)}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept:
        'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json',
    },
  });
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  const digest = res.headers.get('docker-content-digest') ?? '';
  const lastMod = res.headers.get('last-modified') ?? '';
  const pushedAt = lastMod ? new Date(lastMod).toISOString() : new Date().toISOString();
  const body = (await res.json()) as ManifestResponse;
  let size = 0;
  // We don't traverse layers here; keep size 0 (unknown) for v1.
  void body;
  return { digest, size, pushedAt };
}

export interface ListTagsResult {
  ok: true;
  tags: Tag[];
  cachedAt: string;
}

export interface ListTagsError {
  ok: false;
  error: CategorizedError;
}

export async function listTags(
  image: string,
  { force = false } = {},
): Promise<ListTagsResult | ListTagsError> {
  const cached = cache.get(image);
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return { ok: true, tags: cached.tags, cachedAt: new Date(cached.fetchedAt).toISOString() };
  }
  try {
    const token = await getAnonToken(image);
    if (!token) {
      throw new Error('ghcr: failed to obtain anonymous pull token');
    }
    const tagNames = await fetchTagList(image, token);
    const tags: Tag[] = [];
    // Manifest fetches are sequential and rate-aware; cap to MAX_MANIFEST per call.
    const MAX = 80;
    const subset = tagNames.slice(-MAX); // newest tags are typically last in the list
    for (const name of subset) {
      try {
        const { digest, pushedAt } = await fetchManifestDigest(image, name, token);
        tags.push({ name, channel: classifyChannel(name), digest, pushedAt });
      } catch {
        // skip tags we can't fetch manifests for (e.g. deleted)
      }
    }
    cache.set(image, { tags, fetchedAt: Date.now() });
    return { ok: true, tags, cachedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: categorizeError(err) };
  }
}

export function __resetGhcrCacheForTests(): void {
  cache.clear();
}
