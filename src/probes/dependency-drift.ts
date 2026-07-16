import type { ProbeResult } from './types.js';
import { loadDriftReport } from '../drift/store.js';
import type { DriftClassification, DriftPackage } from '../drift/types.js';

const ID = 'dependency-drift';
const LABEL = 'Dependency drift';

/** Registry data older than this gets called out in the message. Stale data
 *  can only UNDERSTATE drift (published versions move forward, they don't
 *  retreat), so a major computed against an old `latest` still warns — the
 *  operator just learns how old the comparison is. */
const STALE_AFTER_MS = 7 * 24 * 3600 * 1000;

// Severity order for picking a package's worst location classification.
// Mirrors the Drift tab's sort order.
const SEVERITY: Record<DriftClassification, number> = {
  major: 5,
  minor: 4,
  patch: 3,
  prerelease: 2,
  unknown: 1,
  'up-to-date': 0,
};

interface MajorEntry {
  name: string;
  location: 'image' | 'data dir';
  installed: string;
  latest: string | null;
  /** The package's own registry-fetch timestamp — staleness is judged per
   *  package, not from the report-level lastSuccessfulScanAt, because a
   *  partial scan can refresh one package while another still carries a
   *  week-old `latest`. */
  lastFetchedAt: string | null;
}

function collectMajors(packages: DriftPackage[]): MajorEntry[] {
  const majors: MajorEntry[] = [];
  for (const p of packages) {
    if (p.image?.classification === 'major') {
      majors.push({
        name: p.name,
        location: 'image',
        installed: p.image.installed,
        latest: p.latest,
        lastFetchedAt: p.lastFetchedAt,
      });
    }
    if (p.dataDir?.classification === 'major') {
      majors.push({
        name: p.name,
        location: 'data dir',
        installed: p.dataDir.installed,
        latest: p.latest,
        lastFetchedAt: p.lastFetchedAt,
      });
    }
  }
  return majors;
}

/** True when the package's drift cannot be fully judged: no location was
 *  resolved at all, or a resolved location lacks a registry comparison. */
function isUncompared(p: DriftPackage): boolean {
  if (p.image === null && p.dataDir === null) return true;
  return p.image?.classification === 'unknown' || p.dataDir?.classification === 'unknown';
}

function worstOf(p: DriftPackage): DriftClassification {
  const classifications = [p.image?.classification, p.dataDir?.classification].filter(
    (c): c is DriftClassification => c !== undefined,
  );
  let worst: DriftClassification | null = null;
  for (const c of classifications) {
    if (worst === null || SEVERITY[c] > SEVERITY[worst]) worst = c;
  }
  // No resolved location at all → nothing to classify.
  return worst ?? 'unknown';
}

/** "5 up-to-date, 2 minor, 1 patch behind" — zero-count buckets omitted. */
function countSummary(packages: DriftPackage[]): string {
  const counts = new Map<DriftClassification, number>();
  for (const p of packages) {
    const worst = worstOf(p);
    counts.set(worst, (counts.get(worst) ?? 0) + 1);
  }
  const parts: string[] = [];
  const phrase: Record<DriftClassification, string> = {
    'up-to-date': 'up-to-date',
    patch: 'patch behind',
    minor: 'minor behind',
    major: 'major behind',
    prerelease: 'prerelease',
    unknown: 'not compared yet',
  };
  for (const cls of Object.keys(SEVERITY) as DriftClassification[]) {
    const n = counts.get(cls);
    if (n !== undefined && n > 0) parts.push(`${n} ${phrase[cls]}`);
  }
  return parts.join(', ');
}

/** Age of the OLDEST per-package registry fetch among the entries a message
 *  is about. The report-level lastSuccessfulScanAt only proves the registry
 *  was reached for at least one package; a partial scan can leave another
 *  package's comparison a week old, and that package's age is the one the
 *  operator must see. Null when no considered entry has ever been fetched. */
function oldestFetchAgeMs(fetchedAts: Array<string | null>): number | null {
  let oldest: number | null = null;
  for (const iso of fetchedAts) {
    if (iso === null) continue;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  return oldest === null ? null : Date.now() - oldest;
}

function staleSuffix(ageMs: number | null): string {
  if (ageMs === null || ageMs < STALE_AFTER_MS) return '';
  return ` (registry data ${(ageMs / 86_400_000).toFixed(1)} days old)`;
}

function result(
  t0: number,
  status: ProbeResult['status'],
  message: string,
  details?: Record<string, unknown>,
): ProbeResult {
  return { id: ID, label: LABEL, status, message, details, durationMs: Date.now() - t0 };
}

/**
 * Surface the Drift tab's verdict on the Health tab: warn when any tracked
 * npm package is a MAJOR version behind the registry at either location
 * (image copy — what the server core loads; data-dir copy — the user's
 * plugin dependencies). Minor/patch drift stays `ok` with a count summary:
 * minors accumulate constantly between signalk-server releases, and a
 * permanent warning trains operators to ignore the probe.
 *
 * Reads only the report the drift scheduler persists — no network, no
 * container reads — so it fits the probe budget regardless of connectivity.
 */
export async function probeDependencyDrift(): Promise<ProbeResult> {
  const t0 = Date.now();
  const report = await loadDriftReport();
  if (report === null) {
    return result(
      t0,
      'unknown',
      'no drift report yet — the scanner runs shortly after boot, or use Rescan on the Drift tab',
    );
  }

  const baseDetails = {
    signalkImageTag: report.signalkImageTag,
    lastScannedAt: report.lastScannedAt,
    lastSuccessfulScanAt: report.lastSuccessfulScanAt,
  };

  if (report.packages.length === 0) {
    return result(
      t0,
      'unknown',
      'drift report has no tracked packages — see the Drift tab for the scan status',
      baseDetails,
    );
  }

  const anyLocation = report.packages.some((p) => p.image !== null || p.dataDir !== null);
  if (!anyLocation) {
    // Post-migration state: a pre-0.8 report kept its registry cache but the
    // per-location versions refill only on the next scan.
    return result(
      t0,
      'unknown',
      'package locations not scanned yet — awaiting the next drift scan',
      baseDetails,
    );
  }

  const majors = collectMajors(report.packages);

  if (majors.length > 0) {
    const list = majors
      .map((m) => `${m.name} (${m.location}) ${m.installed} → ${m.latest ?? '?'}`)
      .join('; ');
    const stale = staleSuffix(oldestFetchAgeMs(majors.map((m) => m.lastFetchedAt)));
    return result(
      t0,
      'warn',
      `${majors.length} package cop${majors.length === 1 ? 'y' : 'ies'} a major version behind: ${list} — see the Drift tab${stale}`,
      { ...baseDetails, majors },
    );
  }

  const summary = countSummary(report.packages);
  const stale = staleSuffix(oldestFetchAgeMs(report.packages.map((p) => p.lastFetchedAt)));

  // A location without a registry comparison could itself be major-behind,
  // so "no major drift" is unprovable while any classification is unknown —
  // stay honest and report the comparison as incomplete instead of ok.
  // Checked per LOCATION, not via worstOf(): a sibling location's minor
  // outranks unknown in the severity order and would hide it.
  const hasUnknown = report.packages.some(isUncompared);
  if (hasUnknown) {
    return result(
      t0,
      'unknown',
      `comparison incomplete: ${summary} — rescan on the Drift tab${stale}`,
      baseDetails,
    );
  }

  return result(
    t0,
    'ok',
    `${report.packages.length} tracked package${report.packages.length === 1 ? '' : 's'}: ${summary}; no major drift${stale}`,
    baseDetails,
  );
}
