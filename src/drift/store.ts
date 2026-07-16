import { open, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  DriftClassification,
  DriftFetchError,
  DriftFetchReason,
  DriftLocation,
  DriftPackage,
  DriftReport,
} from './types.js';

// Resolved at request time so tests can override DOCTOR_DATA between scans
// (and so an installer can adjust the mount path without rebuilding).
function doctorData(): string {
  return process.env.DOCTOR_DATA ?? '/data';
}
function driftPath(): string {
  return join(doctorData(), 'drift.json');
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeAtomic(filePath: string, body: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.write(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, filePath);
  await fsyncDir(dirname(filePath));
}

const CURRENT_REASONS: ReadonlySet<DriftFetchReason> = new Set(['unreachable', 'runtime']);

// Reasons written before the filesystem-reader swap (the HTTP-era
// /skServer/diagnostics path). Accepted on load and rewritten forward so an
// existing drift.json — possibly mid-outage at upgrade — still loads and
// keeps its carried-forward packages instead of being discarded. The next
// successful scan overwrites the file with a clean current reason.
const RETIRED_REASON_MAP: Readonly<Record<string, DriftFetchReason>> = {
  // "couldn't get the data over HTTP"
  network: 'unreachable',
  'no-token': 'unreachable',
  auth: 'unreachable',
  http: 'unreachable',
  // "talked to the server but the data wasn't usable"
  'not-found': 'runtime',
  'bad-payload': 'runtime',
};

function isCurrentReason(value: unknown): value is DriftFetchReason {
  return typeof value === 'string' && CURRENT_REASONS.has(value as DriftFetchReason);
}

// Accept either a current reason or a retired one on disk; a value that is
// neither (e.g. a hand-edited typo) is still rejected so the report is
// discarded and recomputed rather than crashing UI lookups.
function isAcceptableReasonOnDisk(value: unknown): value is string {
  return isCurrentReason(value) || (typeof value === 'string' && value in RETIRED_REASON_MAP);
}

const CLASSIFICATIONS: ReadonlySet<DriftClassification> = new Set([
  'up-to-date',
  'patch',
  'minor',
  'major',
  'prerelease',
  'unknown',
]);

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asLocation(value: unknown): DriftLocation | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { installed?: unknown; classification?: unknown };
  if (typeof v.installed !== 'string') return null;
  return {
    installed: v.installed,
    classification: CLASSIFICATIONS.has(v.classification as DriftClassification)
      ? (v.classification as DriftClassification)
      : 'unknown',
  };
}

/** Migrate one on-disk package entry to the current two-location shape.
 *  Pre-v0.8 entries carried a single first-hit-wins `installed` version whose
 *  location (image vs data dir) is unknowable in hindsight — keep the parts
 *  that stay meaningful offline (latest/etag/lastFetchedAt, which need the
 *  registry to rebuild) and drop the ambiguous version; the next scan refills
 *  both locations from purely local container reads. Entries without a name
 *  are dropped. */
function migratePackage(value: unknown): DriftPackage | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || v.name.length === 0) return null;
  const legacy = typeof v.installed === 'string';
  return {
    name: v.name,
    image: legacy ? null : asLocation(v.image),
    dataDir: legacy ? null : asLocation(v.dataDir),
    latest: strOrNull(v.latest),
    etag: strOrNull(v.etag),
    lastFetchedAt: strOrNull(v.lastFetchedAt),
  };
}

function isDriftFetchError(value: unknown): value is DriftFetchError | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const v = value as { reason?: unknown; detail?: unknown };
  return isAcceptableReasonOnDisk(v.reason) && typeof v.detail === 'string';
}

function isDriftReport(value: unknown): value is DriftReport {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<DriftReport> & { lastFetchError?: unknown };
  return (
    (typeof v.signalkImageTag === 'string' || v.signalkImageTag === null) &&
    typeof v.lastScannedAt === 'string' &&
    (typeof v.lastSuccessfulScanAt === 'string' || v.lastSuccessfulScanAt === null) &&
    typeof v.online === 'boolean' &&
    // lastFetchError is allowed to be absent (pre-v0.7.5 reports) — the
    // migration in loadDriftReport will default it to null. When present
    // it must be either null or a well-formed { reason, detail } object;
    // a malformed value would crash UI lookups like
    // FETCH_ERROR_GUIDANCE[reason], so refuse to load instead.
    (!('lastFetchError' in v) || isDriftFetchError(v.lastFetchError)) &&
    Array.isArray(v.packages)
  );
}

export async function loadDriftReport(): Promise<DriftReport | null> {
  // Validate at the disk boundary: a stale or hand-edited file could be
  // malformed-but-valid-JSON. Returning null on that path lets the scanner
  // recompute from scratch instead of crashing on a missing `packages` array.
  try {
    const raw = await readFile(driftPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isDriftReport(parsed)) return null;
    // Migrate missing `lastFetchError` (added v0.7.5) to null so the
    // wire shape stays uniform regardless of when the file was written.
    if (!('lastFetchError' in parsed)) {
      (parsed as DriftReport).lastFetchError = null;
    }
    // Rewrite a retired HTTP-era reason forward to its current equivalent.
    const fetchError = parsed.lastFetchError;
    if (fetchError && fetchError.reason in RETIRED_REASON_MAP) {
      const mapped = RETIRED_REASON_MAP[fetchError.reason];
      if (mapped) fetchError.reason = mapped;
    }
    // Migrate each package entry to the two-location shape (and validate
    // entries written in the current shape, dropping malformed ones).
    parsed.packages = (parsed.packages as unknown[])
      .map(migratePackage)
      .filter((p): p is DriftPackage => p !== null);
    return parsed;
  } catch {
    return null;
  }
}

export async function saveDriftReport(report: DriftReport): Promise<void> {
  await mkdir(doctorData(), { recursive: true });
  await writeAtomic(driftPath(), JSON.stringify(report, null, 2));
}
