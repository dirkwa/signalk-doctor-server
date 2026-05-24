import type { DriftClassification } from './types.js';

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.+-]+))?$/;

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parse(v: string): Parsed | null {
  const m = v.trim().match(SEMVER_RE);
  if (!m) return null;
  const major = m[1];
  const minor = m[2];
  const patch = m[3];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease: m[4] ?? null,
  };
}

/**
 * Classify the gap between an installed version and the latest version
 * published to npm. Only flags drift when `latest > installed` — caret
 * ranges that already permit minor upgrades are still flagged so the
 * operator sees that a newer image *exists*, even if the range would
 * have allowed the upgrade.
 */
export function classify(installed: string, latest: string): DriftClassification {
  const a = parse(installed);
  const b = parse(latest);
  if (!a || !b) return 'unknown';

  if (a.major === b.major && a.minor === b.minor && a.patch === b.patch) {
    // Same numeric triple; difference is only prerelease state.
    if (a.prerelease === b.prerelease) return 'up-to-date';
    return 'prerelease';
  }
  if (b.major > a.major) return 'major';
  if (b.major === a.major && b.minor > a.minor) return 'minor';
  if (b.major === a.major && b.minor === a.minor && b.patch > a.patch) return 'patch';
  // latest < installed: the running image is ahead of npm `latest` (happens
  // on prereleases pinned via `next` dist-tag, or local dev builds). Treat
  // as up-to-date — there's nothing for the operator to apply.
  return 'up-to-date';
}
