import { resolveRuntime, safe } from '../podman/client.js';
import { fetchInstalledPackages, type InstalledPackage } from './installed-packages.js';
import { getLatestVersion, type NpmRegistryResult } from './npm-registry.js';
import { classify } from './classify.js';
import { loadDriftReport, saveDriftReport } from './store.js';
import type { DriftPackage, DriftReport } from './types.js';

const PER_PACKAGE_JITTER_MS = 100;

async function readRunningSignalkImage(): Promise<string | null> {
  const rt = await resolveRuntime();
  if (!rt) return null;
  const result = await safe(() => rt.client.getContainer('signalk-server').inspect());
  if (!result.ok) return null;
  const info = result.value as unknown as {
    Image?: string;
    ImageName?: string;
    Config?: { Image?: string };
  };
  return info.ImageName ?? info.Config?.Image ?? info.Image ?? null;
}

async function jitter(maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * maxMs);
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

function priorEntry(report: DriftReport | null, name: string): DriftPackage | undefined {
  return report?.packages.find((p) => p.name === name);
}

function buildPackageEntry(
  installed: InstalledPackage,
  registry: NpmRegistryResult,
  prior: DriftPackage | undefined,
  nowIso: string,
): DriftPackage {
  switch (registry.kind) {
    case 'fetched':
      return {
        name: installed.name,
        installed: installed.version,
        latest: registry.version,
        classification: classify(installed.version, registry.version),
        etag: registry.etag,
        lastFetchedAt: nowIso,
      };
    case 'not-modified': {
      // Latest hasn't changed since prior scan; reuse the prior latest but
      // reclassify in case the installed version moved.
      const lastLatest = prior?.latest ?? null;
      return {
        name: installed.name,
        installed: installed.version,
        latest: lastLatest,
        classification: lastLatest ? classify(installed.version, lastLatest) : 'unknown',
        etag: registry.etag || (prior?.etag ?? null),
        lastFetchedAt: nowIso,
      };
    }
    case 'offline':
    case 'error':
      // Carry the prior result forward so the UI keeps showing the last good
      // value; only refresh `installed` (the local truth that doesn't need
      // internet).
      return {
        name: installed.name,
        installed: installed.version,
        latest: prior?.latest ?? null,
        classification: prior?.latest ? classify(installed.version, prior.latest) : 'unknown',
        etag: prior?.etag ?? null,
        lastFetchedAt: prior?.lastFetchedAt ?? null,
      };
  }
}

export interface ScanOutcome {
  report: DriftReport;
  /** True if any package fetch succeeded (fetched or not-modified). */
  online: boolean;
  /** Human-readable reason when the scan couldn't read installed packages. */
  installedFetchError: string | null;
}

export async function runDriftScan(): Promise<ScanOutcome> {
  const nowIso = new Date().toISOString();
  const prior = await loadDriftReport();
  const newImageTag = await readRunningSignalkImage();

  // Image switched since last scan: discard the previous packages array.
  // Don't merge — the new image has its own pinned set, and stale entries
  // for packages that were dropped would be misleading. But only treat a
  // change as positively known when the new tag is itself known; a null
  // newImageTag means the container couldn't be inspected this tick (no
  // podman socket, transient outage), which must NOT wipe the cache.
  const imageChanged =
    prior?.signalkImageTag != null &&
    newImageTag != null &&
    prior.signalkImageTag !== newImageTag;
  const baseReport: DriftReport | null = imageChanged ? null : prior;

  const installedRes = await fetchInstalledPackages();
  if (!installedRes.ok) {
    const report: DriftReport = {
      signalkImageTag: newImageTag,
      lastScannedAt: nowIso,
      lastSuccessfulScanAt: baseReport?.lastSuccessfulScanAt ?? null,
      online: false,
      // Keep prior packages array intact when we can't read fresh data.
      packages: baseReport?.packages ?? [],
    };
    await saveDriftReport(report);
    return {
      report,
      online: false,
      installedFetchError: `${installedRes.reason}: ${installedRes.detail}`,
    };
  }

  const packages: DriftPackage[] = [];
  let anyOnline = false;
  for (const installed of installedRes.packages) {
    const priorPkg = priorEntry(baseReport, installed.name);
    const registry = await getLatestVersion(installed.name, priorPkg?.etag ?? null);
    if (registry.kind === 'fetched' || registry.kind === 'not-modified') {
      anyOnline = true;
    }
    packages.push(buildPackageEntry(installed, registry, priorPkg, nowIso));
    await jitter(PER_PACKAGE_JITTER_MS);
  }

  const report: DriftReport = {
    signalkImageTag: newImageTag,
    lastScannedAt: nowIso,
    lastSuccessfulScanAt: anyOnline ? nowIso : (baseReport?.lastSuccessfulScanAt ?? null),
    online: anyOnline,
    packages,
  };
  await saveDriftReport(report);
  return { report, online: anyOnline, installedFetchError: null };
}
