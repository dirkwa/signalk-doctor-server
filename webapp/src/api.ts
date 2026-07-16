// API client for the SignalK Doctor console. Same-origin: the React
// bundle is served by the Fastify host on port 3004 (standalone), and
// also by the signalk-doctor plugin's reverse proxy under
// /plugins/signalk-doctor/console/* (embedded). In both cases the
// browser sees the bundle and the API on the same origin.
//
// API base discovery: when this webapp is loaded standalone, paths
// resolve at /api/*. When proxied by signalk-doctor, the plugin
// injects <meta name="api-base" content="/plugins/signalk-doctor/console">
// into the HTML response; we read it once at module load and prefix
// every API/EventSource URL. logsStreamUrl() goes through API_BASE too,
// so EventSource consumers (useLogStream) pick the prefix up for free.

/**
 * Read <meta name="api-base"> once. Empty / missing tag means the webapp
 * is running standalone and paths should not be prefixed. Trailing slash
 * is stripped so `${apiBase}/api/x` always produces exactly one slash
 * between segments. Exported for tests.
 */
export function readApiBase(): string {
  if (typeof document === 'undefined') return '';
  const meta = document.querySelector('meta[name="api-base"]');
  const raw = meta?.getAttribute('content') ?? '';
  return raw.replace(/\/+$/, '');
}

const API_BASE = `${readApiBase()}/api`;

/** Exposed for callers that build URLs by hand (e.g. download links). */
export function getApiBase(): string {
  return API_BASE;
}

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
  'updated' | 'unchanged' | 'mount-missing' | 'fetch-failed' | 'write-failed';

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
  'up-to-date' | 'patch' | 'minor' | 'major' | 'prerelease' | 'unknown';

/** One resolved copy of a tracked package at a specific location. */
export interface DriftLocation {
  installed: string;
  classification: DriftClassification;
}

export interface DriftPackage {
  name: string;
  /** The copy baked into the image (what the server core loads); null when
   *  the image doesn't carry the package. */
  image: DriftLocation | null;
  /** The copy in the data dir's plugin tree, npm-installed as a dependency
   *  of the user's plugins; null when no data-dir copy exists. */
  dataDir: DriftLocation | null;
  latest: string | null;
  lastFetchedAt: string | null;
}

export type DriftFetchReason = 'unreachable' | 'runtime';

export interface DriftFetchError {
  reason: DriftFetchReason;
  detail: string;
}

export interface DriftReport {
  signalkImageTag: string | null;
  lastScannedAt: string;
  lastSuccessfulScanAt: string | null;
  online: boolean;
  /** Why the most recent scan couldn't read installed packages from
   *  signalk-server, if any. Null when the last scan was OK. */
  lastFetchError: DriftFetchError | null;
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

interface BugReportStartResponse {
  jobId: string;
  status: 'running';
  startedAt: string;
  reused?: boolean;
}

type BugReportJobResponse =
  | { status: 'running'; startedAt: string }
  | {
      status: 'done';
      startedAt: string;
      finishedAt: string;
      filename: string;
      sizeBytes: number;
      durationMs: number;
    }
  | {
      status: 'error';
      startedAt: string;
      finishedAt: string;
      reason: string;
      detail: string;
      stderr?: string;
      exitCode?: number;
      durationMs: number;
    };

const POLL_INTERVAL_MS = 2000;
// Hard ceiling on how long we'll poll a single job. The engine caps the
// host collector at 10 minutes (BUG_REPORT_TIMEOUT_MS); give a little
// slack so a job that times out engine-side surfaces its own 'error'
// before we bail with this client-side guard.
const POLL_TIMEOUT_MS = 11 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run the full async bug-report flow and return the tarball as a Blob
 *  plus metadata. Three hops so the signalk-doctor plugin proxy's 15s
 *  header watchdog never trips (a synchronous collector blocks past it
 *  on a cold boat → "HTTP 502" every time):
 *
 *    1. POST /api/bug-report           → 202 { jobId } (headers in <1s)
 *    2. GET  /api/bug-report/:jobId     → poll until status !== 'running'
 *    3. GET  /api/bug-report/:jobId/download → stream the tarball
 *
 *  `onProgress` fires once per poll with the seconds elapsed so the view
 *  can show a live "collecting… 42s" counter instead of a dead spinner. */
export async function downloadBugReport(
  onProgress?: (elapsedSeconds: number) => void,
): Promise<BugReportSuccess> {
  // 1. Start the job (mutating → bearer attached by buildHeaders).
  const started = await request<BugReportStartResponse>('/bug-report', { method: 'POST' });
  const jobId = started.jobId;

  // 2. Poll until the job leaves 'running'. Read-only GET, no bearer.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const job = await request<BugReportJobResponse>(`/bug-report/${encodeURIComponent(jobId)}`);
    if (job.status === 'done') {
      return downloadReadyTarball(jobId);
    }
    if (job.status === 'error') {
      const err: ApiError = new Error(job.detail || `bug-report failed (${job.reason})`);
      err.status = 500;
      err.body = job;
      throw err;
    }
    onProgress?.(Math.round((Date.now() - new Date(started.startedAt).getTime()) / 1000));
    await sleep(POLL_INTERVAL_MS);
  }
  const err: ApiError = new Error(
    'bug-report did not finish in time — the tarball may still land under ' +
      '~/.signalk-doctor/bug-reports/ on the host; retrieve it via SSH.',
  );
  err.status = 504;
  throw err;
}

/** Step 3 of downloadBugReport: fetch the finished tarball as a Blob.
 *  Separate from request<T> because that text()-parses the body and would
 *  corrupt the binary gzip. Read-only GET — no bearer (the random jobId is
 *  the capability). */
async function downloadReadyTarball(jobId: string): Promise<BugReportSuccess> {
  const res = await fetch(`${API_BASE}/bug-report/${encodeURIComponent(jobId)}/download`, {
    headers: buildHeaders({}),
  });
  if (!res.ok) {
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

/** Generate a 128-bit hex random string via the web crypto API.
 *  Same entropy as `crypto.randomUUID()` (which we can't use here:
 *  `randomUUID` is gated to secure contexts only, and the Doctor
 *  Console is normally served over plain http on the boat's LAN —
 *  192.168.0.x:3004 is not a secure context, so the call throws
 *  "crypto.randomUUID is not a function"). `getRandomValues` works
 *  in every context including http. */
function randomHex16(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Upload a bug-report tarball to filebin.net and return the
 *  publicly-accessible URL.
 *
 *  filebin.net is unauthenticated public storage. Its CORS reply
 *  includes `Access-Control-Allow-Origin: *` but does NOT echo
 *  `Access-Control-Allow-Methods` or `Access-Control-Allow-Headers`
 *  — so any CORS-preflighted request fails with "Failed to fetch"
 *  in the browser. We sidestep the preflight by issuing a "simple
 *  request" per the CORS spec: no custom Content-Type, no custom
 *  headers, just `POST` with the body. Filebin doesn't need an
 *  explicit Content-Type anyway — it infers from extension.
 *
 *  The `new Blob([blob], { type: '' })` re-wrap is required because
 *  `fetch(url, { body: blob })` reads `blob.type` and sets the
 *  Content-Type header from it. The incoming blob came from
 *  `res.blob()` on `/api/bug-report` which had
 *  `Content-Type: application/gzip` — so the original blob inherits
 *  that, and a naive `body: blob` would re-add the header, trip the
 *  preflight, and break the upload.
 *
 *  The bin name is the only access control filebin offers; we use
 *  a cryptographically random suffix (128 bits of entropy via
 *  `crypto.getRandomValues`) plus an ISO timestamp prefix so the URL
 *  is unguessable in practice. Bins auto-expire after ~6 days
 *  regardless. */
export async function uploadToFilebin(filename: string, blob: Blob): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const rand = randomHex16();
  const bin = `signalk-${stamp}-${rand}`;
  const url = `https://filebin.net/${bin}/${encodeURIComponent(filename)}`;
  // Strip the blob's Content-Type so fetch doesn't auto-set a header
  // that would force a CORS preflight. See docblock above.
  const untyped = new Blob([blob], { type: '' });
  const res = await fetch(url, { method: 'POST', body: untyped });
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
