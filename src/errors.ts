export type ErrorKind =
  'network' | 'registry-unavailable' | 'auth' | 'disk' | 'permission' | 'not-found' | 'unknown';

export interface CategorizedError {
  kind: ErrorKind;
  userMessage: string;
  raw: string;
}

const NET_PATTERNS = [
  /ENOTFOUND/,
  /ECONNREFUSED/,
  /EHOSTUNREACH/,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /EAI_AGAIN/,
  /UND_ERR/, // undici fetch failures (e.g. "fetch failed" socket errors)
  /no route to host/i,
  /network is unreachable/i,
];

// A registry/upstream returning a 5xx (or 429) is transient — momentarily
// unavailable or throttling, not a misconfiguration. Surfaced as a distinct,
// retryable kind so the UI can say "try again" instead of treating it like a
// hard failure. The `HTTP 5xx` strings come from ghcr.ts's throws on a
// non-ok upstream response.
const REGISTRY_UNAVAILABLE_PATTERNS = [
  /HTTP 5\d\d/,
  /HTTP 429/,
  /\bfetch failed\b/i,
  /503 Service Unavailable/i,
  /502 Bad Gateway/i,
];

const AUTH_PATTERNS = [/unauthorized/i, /authentication required/i, /denied: requested access/i];

const DISK_PATTERNS = [/no space left/i, /enospc/i, /disk quota/i];

const PERM_PATTERNS = [/permission denied/i, /eacces/i, /eperm/i, /operation not permitted/i];

const NOT_FOUND_PATTERNS = [/no such (image|container)/i, /enoent/i, /not found/i];

export function categorizeError(err: unknown): CategorizedError {
  const raw = err instanceof Error ? err.message : String(err);

  if (NET_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: 'network',
      userMessage: 'Could not reach the registry. Check connectivity and try again.',
      raw,
    };
  }
  // Auth is checked before registry-unavailable so a 401/403 stays 'auth'.
  // (The 5xx/429 pattern can't match those, but keep the order explicit.)
  if (AUTH_PATTERNS.some((p) => p.test(raw))) {
    return { kind: 'auth', userMessage: 'Registry authentication failed.', raw };
  }
  if (REGISTRY_UNAVAILABLE_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: 'registry-unavailable',
      userMessage: 'The registry is temporarily unavailable. Try again in a moment.',
      raw,
    };
  }
  if (DISK_PATTERNS.some((p) => p.test(raw))) {
    return { kind: 'disk', userMessage: 'Disk full. Free space and retry.', raw };
  }
  if (PERM_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: 'permission',
      userMessage: 'Permission denied. Check container socket and mount permissions.',
      raw,
    };
  }
  if (NOT_FOUND_PATTERNS.some((p) => p.test(raw))) {
    return { kind: 'not-found', userMessage: 'Resource not found.', raw };
  }
  return { kind: 'unknown', userMessage: 'Unexpected error. See logs for details.', raw };
}
