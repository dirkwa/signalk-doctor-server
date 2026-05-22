export type ErrorKind = 'network' | 'auth' | 'disk' | 'permission' | 'not-found' | 'unknown';

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
  /no route to host/i,
  /network is unreachable/i,
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
      userMessage: 'Network error. Check connectivity to the registry.',
      raw,
    };
  }
  if (AUTH_PATTERNS.some((p) => p.test(raw))) {
    return { kind: 'auth', userMessage: 'Registry authentication failed.', raw };
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
