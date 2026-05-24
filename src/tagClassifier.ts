import type { Channel } from './types.js';

/**
 * Classify a container image tag into one of the user-facing channels:
 *
 * - **stable** — pure semver: `v1.2.3`, `1.2.3`.
 * - **beta** — prerelease semver: `v1.2.3-beta.1`, `v1.2.3-rc.2`.
 * - **master** — `master-<sha>` / `main-<sha>` / `master` / `main` bare.
 * - **dirkwa** — anything starting with `dirkwa-`. Fork channel.
 *
 * Unrecognised tags map to `dirkwa` (the safe "user/dev" bucket).
 */
export function classifyChannel(tag: string): Channel {
  const t = tag.trim();
  if (!t) return 'dirkwa';

  if (/^v?\d+\.\d+\.\d+(-(beta|rc)\.\d+)?$/i.test(t)) {
    return /-((beta|rc)\.)/i.test(t) ? 'beta' : 'stable';
  }
  if (/^(master|main)(-[0-9a-f]{4,40})?$/i.test(t)) return 'master';
  if (/^dirkwa-/i.test(t)) return 'dirkwa';
  return 'dirkwa';
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?$/i;

/**
 * Compare two semver-ish tags. Returns >0 if a is newer, <0 if b is newer,
 * 0 if equal or incomparable.
 */
export function compareSemver(a: string, b: string): number {
  const A = a.match(SEMVER_RE);
  const B = b.match(SEMVER_RE);
  if (!A || !B) return 0;
  for (let i = 1; i <= 3; i++) {
    const ai = A[i];
    const bi = B[i];
    if (ai === undefined || bi === undefined) return 0;
    const da = Number.parseInt(ai, 10);
    const db = Number.parseInt(bi, 10);
    if (da !== db) return da - db;
  }
  // prerelease: absence > presence (stable > prerelease)
  const aPre = A[4] ? `${A[4]}.${A[5]}` : '';
  const bPre = B[4] ? `${B[4]}.${B[5]}` : '';
  if (aPre === bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  return aPre.localeCompare(bPre);
}
