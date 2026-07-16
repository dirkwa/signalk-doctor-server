export type DriftClassification =
  'up-to-date' | 'patch' | 'minor' | 'major' | 'prerelease' | 'unknown';

/** One resolved copy of a tracked package at a specific location. */
export interface DriftLocation {
  installed: string;
  classification: DriftClassification;
}

export interface DriftPackage {
  name: string;
  /** The copy in the server's own app tree — what the image ships and what
   *  the server core loads. Changes only when the image is updated. Null
   *  when the image doesn't carry the package. */
  image: DriftLocation | null;
  /** The copy in the data dir's plugin tree (`~/.signalk/node_modules`) —
   *  npm-installed there as a dependency of the user's plugins and loaded
   *  by those plugins. Lives on a persistent mount, so image updates never
   *  touch it. Null when no data-dir copy exists. */
  dataDir: DriftLocation | null;
  /** null when we've never successfully fetched from the registry. */
  latest: string | null;
  /** Last `If-None-Match` ETag returned by the registry, for the next conditional GET. */
  etag: string | null;
  /** ISO timestamp of the last successful fetch (or null if never). */
  lastFetchedAt: string | null;
}

/** Package-read failure reason persisted on the report so the Drift UI
 *  can render reason-specific guidance instead of a generic "offline"
 *  badge. Cleared on success. Mirrors InstalledPackagesReason from
 *  installed-packages.ts; kept as a separate string union here so the
 *  webapp's type mirror doesn't import scanner internals. Older reports
 *  may carry retired HTTP-era reasons on disk; store.ts migrates those
 *  forward on load. */
export type DriftFetchReason = 'unreachable' | 'runtime';

export interface DriftFetchError {
  reason: DriftFetchReason;
  detail: string;
}

export interface DriftReport {
  /** The signalk-server image tag the report was computed against. */
  signalkImageTag: string | null;
  /** ISO timestamp of the most recent scan attempt (success or failure). */
  lastScannedAt: string;
  /** ISO timestamp of the most recent scan that actually reached the registry. */
  lastSuccessfulScanAt: string | null;
  /** True if the most recent scan reached the npm registry for at least one package. */
  online: boolean;
  /** Why the last scan couldn't read installed packages from signalk-server,
   *  if any. Null when the last scan was OK (even if packages array is
   *  empty — that's "online, nothing to report"). */
  lastFetchError: DriftFetchError | null;
  packages: DriftPackage[];
}
