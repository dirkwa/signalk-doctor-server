import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setDefaultAutoSelectFamilyAttemptTimeout,
  getDefaultAutoSelectFamilyAttemptTimeout,
} from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = resolve(here, '..', 'src', 'index.ts');

/**
 * Guard the Happy-Eyeballs fix. The entrypoint must widen the
 * autoSelectFamily attempt timeout from Node's 250ms default so global
 * fetch() to a dual-stack host (ghcr.io / npm registry) over a slow boat
 * link doesn't instant-fail with ETIMEDOUT/"fetch failed" — surfacing as
 * the "Failed to run probes: HTTP 502" the doctor reports. Same Node ≥20
 * bug fixed in signalk-updater-server and noforeignland/nfl-signalk#47.
 * Static-source check because src/index.ts self-runs main() (binds a port)
 * on import.
 */
describe('src/index.ts Happy-Eyeballs attempt-timeout fix', () => {
  it('imports setDefaultAutoSelectFamilyAttemptTimeout from node:net', async () => {
    const src = await readFile(INDEX_TS, 'utf8');
    expect(src).toMatch(
      /import\s*\{[^}]*\bsetDefaultAutoSelectFamilyAttemptTimeout\b[^}]*\}\s*from\s*['"]node:net['"]/,
    );
  });

  it('calls the setter at module scope (before listen)', async () => {
    const src = await readFile(INDEX_TS, 'utf8');
    expect(src).toMatch(/setDefaultAutoSelectFamilyAttemptTimeout\(/);
  });

  it('uses a default timeout well above the 250ms Node default', async () => {
    const src = await readFile(INDEX_TS, 'utf8');
    // The default fallback (|| N) must be >= 5000.
    const m = src.match(/\|\|\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(5000);
  });

  it('floors the value so a misconfigured small/zero env cannot re-introduce the fast-fail', async () => {
    const src = await readFile(INDEX_TS, 'utf8');
    // Math.max(250, …) guards against "0"/"50".
    expect(src).toMatch(/Math\.max\(\s*250\s*,/);
  });
});

describe('autoselect timeout env-guard logic', () => {
  // Mirror of the entrypoint's expression, exercised directly so the NaN /
  // floor behaviour is covered without importing index.ts (which binds a
  // port on import).
  const compute = (env: string | undefined): number => Math.max(250, Number(env) || 5000);

  it('uses 5000 when unset', () => expect(compute(undefined)).toBe(5000));
  it('uses 5000 for a non-numeric env (no NaN)', () => {
    expect(compute('not-a-number')).toBe(5000);
    expect(Number.isNaN(compute('xyz'))).toBe(false);
  });
  it('honors a larger explicit value', () => expect(compute('10000')).toBe(10000));
  it('floors a too-small positive value to 250', () => {
    expect(compute('50')).toBe(250);
    expect(compute('100')).toBe(250);
  });
  it('treats "0" as unset (falsy) and falls back to 5000', () => {
    // `|| 5000` can't distinguish 0 from absent; the safe fallback wins.
    expect(compute('0')).toBe(5000);
  });
});

describe('node:net autoselect timeout is settable (sanity)', () => {
  it('round-trips a 5s value', () => {
    const prev = getDefaultAutoSelectFamilyAttemptTimeout();
    try {
      setDefaultAutoSelectFamilyAttemptTimeout(5000);
      expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5000);
    } finally {
      setDefaultAutoSelectFamilyAttemptTimeout(prev);
    }
  });
});
