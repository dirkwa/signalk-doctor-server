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
  /** null when we've never successfully fetched from the registry. */
  latest: string | null;
  classification: DriftClassification;
  /** Last `If-None-Match` ETag returned by the registry, for the next conditional GET. */
  etag: string | null;
  /** ISO timestamp of the last successful fetch (or null if never). */
  lastFetchedAt: string | null;
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
  packages: DriftPackage[];
}
