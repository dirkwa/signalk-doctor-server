// API client for the SignalK Doctor console. Same-origin: the React
// bundle is served by the Fastify host on port 3004, so every call
// resolves against `/api`. The dev `vite` server proxies `/api` to a
// real doctor-server (see vite.config.ts).

const API_BASE = '/api';

export type ProbeStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface ProbeResult {
  id: string;
  label: string;
  status: ProbeStatus;
  message: string;
  details?: Record<string, unknown>;
  durationMs: number;
}

export interface ProbesResponse {
  ranAt: string;
  durationMs: number;
  results: ProbeResult[];
  summary: { ok: number; warn: number; fail: number; unknown: number };
}

export interface HealthResponse {
  ok: boolean;
  runtime: 'podman' | 'docker' | 'unknown';
  socketPath?: string;
  uptimeSeconds: number;
  version: string;
}

export interface SessionResponse {
  token?: string;
  error?: string;
}

export interface SnapshotEntry {
  name: string;
  path: string;
  mtime: string;
  size: number;
}

export interface SnapshotsResponse {
  count: number;
  snapshots: SnapshotEntry[];
}

export interface LastGoodEntry {
  tag?: string;
  image?: string;
  // The server-side rewriter writes `snapshotPath`. The vanilla webapp
  // looked at `snapshotFile`; accept either so an older/newer doctor
  // engine pair still renders something.
  snapshotPath?: string;
  snapshotFile?: string;
}

export interface LastGoodResponse {
  updatedAt: string | null;
  quadlets: Record<string, LastGoodEntry>;
}

export interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

let cachedToken: string | null = null;

function buildHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && init.body !== null && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  // Per CC-2: only mutating requests carry the bearer. Read-only probes
  // stay unauthenticated by design — they're the recovery surface a
  // desperate user reaches for.
  const isMutating = typeof init.method === 'string' && init.method.toUpperCase() !== 'GET';
  if (cachedToken !== null && isMutating) {
    headers.set('Authorization', `Bearer ${cachedToken}`);
  }
  return headers;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: buildHeaders(init),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${res.status}`;
    const err: ApiError = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export async function loadSession(): Promise<void> {
  try {
    const s = await request<SessionResponse>('/session');
    cachedToken = s.token ?? null;
  } catch {
    // Missing token isn't fatal — only mutating endpoints will reject.
    cachedToken = null;
  }
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export function getProbes(): Promise<ProbesResponse> {
  return request<ProbesResponse>('/probes');
}

export function getSnapshots(): Promise<SnapshotsResponse> {
  return request<SnapshotsResponse>('/snapshots');
}

export function getLastGood(): Promise<LastGoodResponse> {
  return request<LastGoodResponse>('/last-good');
}

export function recoverAll(): Promise<unknown> {
  return request<unknown>('/recover', { method: 'POST' });
}

export function recoverUpdater(): Promise<unknown> {
  return request<unknown>('/recover/updater', { method: 'POST' });
}

export function logsStreamUrl(name: string, tail: number): string {
  return `${API_BASE}/containers/${encodeURIComponent(name)}/logs/stream?tail=${tail}`;
}

export interface CheckUpdateResponse {
  current: string;
  latest?: string;
  updateAvailable: boolean;
  cachedAt?: string;
  /** Where to perform the actual self-update (the doctor never updates itself). */
  updateVia: string;
  error?: string;
}

export function getCheckUpdate(): Promise<CheckUpdateResponse> {
  return request<CheckUpdateResponse>('/self/check-update');
}

// ── Formatting helpers ──────────────────────────────────────

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}
