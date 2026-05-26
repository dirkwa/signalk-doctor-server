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

// ── Installer-refresh types + calls ─────────────────────────

export type InstallerArtifactKind = 'host-script' | 'quadlet-template' | 'detect-script';

export type InstallerArtifactStatus =
  | 'updated'
  | 'unchanged'
  | 'mount-missing'
  | 'fetch-failed'
  | 'write-failed';

export interface InstallerStatusArtifact {
  id: string;
  kind: InstallerArtifactKind;
  destPath: string;
  present: boolean;
  sha256?: string;
  mtime?: string;
}

export interface InstallerStatusResponse {
  hostBinMounted: boolean;
  pagesBase: string;
  artifacts: InstallerStatusArtifact[];
}

export interface InstallerRefreshResult {
  id: string;
  kind: InstallerArtifactKind;
  status: InstallerArtifactStatus;
  sha256?: string;
  snapshotPath?: string;
  message?: string;
}

export interface InstallerRefreshResponse {
  startedAt: string;
  finishedAt: string;
  pagesBase: string;
  results: InstallerRefreshResult[];
  counts: Record<InstallerArtifactStatus, number>;
}

export function getInstallerStatus(): Promise<InstallerStatusResponse> {
  return request<InstallerStatusResponse>('/installer/status');
}

export function refreshInstaller(): Promise<InstallerRefreshResponse> {
  return request<InstallerRefreshResponse>('/installer/refresh', { method: 'POST' });
}

// ── Drift report ────────────────────────────────────────────

export type DriftClassification =
  | 'up-to-date'
  | 'patch'
  | 'minor'
  | 'major'
  | 'prerelease'
  | 'unknown';

export interface DriftPackage {
  name: string;
  installed: string;
  latest: string | null;
  classification: DriftClassification;
  lastFetchedAt: string | null;
}

export interface DriftReport {
  signalkImageTag: string | null;
  lastScannedAt: string;
  lastSuccessfulScanAt: string | null;
  online: boolean;
  packages: DriftPackage[];
}

export function getDrift(): Promise<DriftReport> {
  return request<DriftReport>('/drift');
}

export function refreshDrift(): Promise<DriftReport> {
  return request<DriftReport>('/drift/refresh', { method: 'POST' });
}

// ── Bug report ──────────────────────────────────────────────

export interface BugReportSuccess {
  filename: string;
  sizeBytes: number;
  durationMs: number;
  blob: Blob;
}

/** POST /api/bug-report and return the tarball as a Blob plus metadata
 *  read from response headers. The doctor sets x-bug-report-filename
 *  and x-bug-report-duration-ms so the webapp can show "took 47s, 3.2 MB"
 *  without parsing the binary body. */
export async function downloadBugReport(): Promise<BugReportSuccess> {
  // Don't reuse request<T> — it text()-parses the body and would
  // corrupt a binary tarball. Mirror its auth+header logic instead.
  const init: RequestInit = { method: 'POST', headers: buildHeaders({ method: 'POST' }) };
  const res = await fetch(`${API_BASE}/bug-report`, init);
  if (!res.ok) {
    // Error responses come back as JSON: { error, reason, ... }.
    // Read as text first so we can fall back gracefully on parse
    // failure — calling res.json() then res.text() doesn't work
    // because the body stream is consumed on the first read. Same
    // pattern as request<T> above.
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const msg =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${res.status}`;
    const err: ApiError = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  const blob = await res.blob();
  const filename = res.headers.get('x-bug-report-filename') ?? 'signalk-bug-report.tar.gz';
  const durationMs = Number.parseInt(res.headers.get('x-bug-report-duration-ms') ?? '0', 10) || 0;
  return { filename, sizeBytes: blob.size, durationMs, blob };
}

/** Save a downloaded Blob to the user's Downloads folder by clicking
 *  a synthetic anchor with `download` set. Works in all current
 *  browsers without external deps. */
export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // The browser keeps the object URL alive while the download is in
  // flight, so it's safe to revoke now — but revoking too early on
  // Safari has caused issues, so wait a tick.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Upload a bug-report tarball to filebin.net and return the
 *  publicly-accessible URL.
 *
 *  filebin.net is unauthenticated public storage with wide-open CORS
 *  (Access-Control-Allow-Origin: *), so the browser can POST directly
 *  — no server-side relay needed. Bin names mix timestamp + Math.random
 *  so guessing the URL is infeasible, which is the only access control
 *  filebin offers. Bins auto-expire after ~6 days.
 *
 *  Mirrors the bash `signalk bug-report` upload flow so the two
 *  surfaces produce the same kind of bin URL. The bash flow uses
 *  $RANDOM (POSIX); browser uses Math.random; functionally equivalent
 *  for "unguessable suffix". */
export async function uploadToFilebin(filename: string, blob: Blob): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const rand = Math.floor(Math.random() * 1_000_000).toString();
  const bin = `signalk-${stamp}-${rand}`;
  const url = `https://filebin.net/${bin}/${encodeURIComponent(filename)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip' },
    body: blob,
  });
  if (!res.ok) {
    throw new Error(`filebin upload failed: HTTP ${res.status}`);
  }
  return url;
}

/** Build a github.com/.../issues/new URL with title + body pre-filled.
 *  The body should be plain markdown — GitHub renders it inside the
 *  textarea on the issue page.
 *
 *  Returned URL is meant for `window.open(url, '_blank')` so it lands
 *  in a new tab; the calling page stays put. */
export function buildGithubIssueUrl(opts: {
  repo: string; // e.g. "SignalK/signalk-server"
  title: string;
  body: string;
}): string {
  const params = new URLSearchParams({ title: opts.title, body: opts.body });
  return `https://github.com/${opts.repo}/issues/new?${params.toString()}`;
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
