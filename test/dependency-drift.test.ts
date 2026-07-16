import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDependencyDrift } from '../src/probes/dependency-drift.js';
import { saveDriftReport } from '../src/drift/store.js';
import type { DriftLocation, DriftPackage, DriftReport } from '../src/drift/types.js';

function loc(installed: string, classification: DriftLocation['classification']): DriftLocation {
  return { installed, classification };
}

function pkg(
  name: string,
  image: DriftLocation | null,
  dataDir: DriftLocation | null,
  latest: string | null,
  lastFetchedAt: string | null = new Date().toISOString(),
): DriftPackage {
  return { name, image, dataDir, latest, etag: null, lastFetchedAt };
}

function report(packages: DriftPackage[], overrides: Partial<DriftReport> = {}): DriftReport {
  return {
    signalkImageTag: 'ghcr.io/dirkwa/signalk-server:dirkwa-abc1234',
    lastScannedAt: new Date().toISOString(),
    lastSuccessfulScanAt: new Date().toISOString(),
    online: true,
    lastFetchError: null,
    packages,
    ...overrides,
  };
}

describe('probeDependencyDrift', () => {
  let dir: string;
  const prev = process.env.DOCTOR_DATA;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-drift-'));
    process.env.DOCTOR_DATA = dir;
  });

  afterEach(async () => {
    if (prev === undefined) delete process.env.DOCTOR_DATA;
    else process.env.DOCTOR_DATA = prev;
    await rm(dir, { recursive: true, force: true });
  });

  it('is unknown when no drift report exists yet', async () => {
    const res = await probeDependencyDrift();
    expect(res.id).toBe('dependency-drift');
    expect(res.status).toBe('unknown');
    expect(res.message).toMatch(/no drift report yet/);
  });

  it('warns on a major-behind data-dir copy, naming package, location and versions', async () => {
    await saveDriftReport(
      report([
        pkg('@signalk/streams', loc('6.8.0', 'up-to-date'), loc('5.1.3', 'major'), '6.8.0'),
        pkg('@canboat/canboatjs', loc('3.20.0', 'up-to-date'), null, '3.20.0'),
      ]),
    );
    const res = await probeDependencyDrift();
    expect(res.status).toBe('warn');
    expect(res.message).toMatch(/@signalk\/streams \(data dir\) 5\.1\.3 → 6\.8\.0/);
    expect(res.message).not.toMatch(/canboatjs/);
  });

  it('warns on a major-behind image copy', async () => {
    await saveDriftReport(report([pkg('@signalk/streams', loc('5.1.3', 'major'), null, '6.8.0')]));
    const res = await probeDependencyDrift();
    expect(res.status).toBe('warn');
    expect(res.message).toMatch(/@signalk\/streams \(image\) 5\.1\.3 → 6\.8\.0/);
  });

  it('stays ok for minor/patch drift, with a count summary', async () => {
    await saveDriftReport(
      report([
        pkg('@signalk/server-api', loc('2.30.0', 'up-to-date'), loc('2.24.0', 'minor'), '2.30.0'),
        pkg('@canboat/ts-pgns', loc('1.11.17', 'patch'), null, '1.11.18'),
        pkg('@canboat/canboatjs', loc('3.20.0', 'up-to-date'), null, '3.20.0'),
      ]),
    );
    const res = await probeDependencyDrift();
    expect(res.status).toBe('ok');
    expect(res.message).toMatch(/3 tracked packages/);
    expect(res.message).toMatch(/1 minor behind/);
    expect(res.message).toMatch(/1 patch behind/);
    expect(res.message).toMatch(/1 up-to-date/);
    expect(res.message).toMatch(/no major drift/);
  });

  it('still warns on stale registry data, aging it from the PACKAGE fetch timestamp', async () => {
    // Stale `latest` can only understate drift — a major computed against a
    // week-old registry snapshot is at least that far behind, so the warning
    // must not soften to unknown; it carries the age instead. The age comes
    // from the major package's own lastFetchedAt: a partial scan can refresh
    // one package (making the report-level lastSuccessfulScanAt fresh) while
    // the major entry still rests on a ten-day-old comparison.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    await saveDriftReport(
      report([
        pkg('@signalk/streams', loc('5.1.3', 'major'), null, '6.8.0', tenDaysAgo),
        pkg('@canboat/canboatjs', loc('3.20.0', 'up-to-date'), null, '3.20.0'),
      ]),
    );
    const res = await probeDependencyDrift();
    expect(res.status).toBe('warn');
    expect(res.message).toMatch(/registry data 10\.0 days old/);
  });

  it('does not call fresh registry data stale', async () => {
    await saveDriftReport(
      report([pkg('@signalk/server-api', loc('2.24.0', 'minor'), null, '2.30.0')]),
    );
    const res = await probeDependencyDrift();
    expect(res.status).toBe('ok');
    expect(res.message).not.toMatch(/days old/);
  });

  it('is unknown for a migrated pre-0.8 report whose locations are not yet rescanned', async () => {
    await saveDriftReport(report([pkg('@signalk/streams', null, null, '6.8.0')]));
    const res = await probeDependencyDrift();
    expect(res.status).toBe('unknown');
    expect(res.message).toMatch(/awaiting the next drift scan/);
  });

  it('is unknown when versions were read but the registry was never reached', async () => {
    await saveDriftReport(
      report([pkg('@signalk/streams', loc('6.6.0', 'unknown'), null, null, null)], {
        lastSuccessfulScanAt: null,
        online: false,
      }),
    );
    const res = await probeDependencyDrift();
    expect(res.status).toBe('unknown');
    expect(res.message).toMatch(/comparison incomplete/);
  });

  it('is unknown — not ok — when any package is still uncompared', async () => {
    // "No major drift" is unprovable while a package lacks a registry
    // comparison: the uncompared one could itself be major-behind.
    await saveDriftReport(
      report([
        pkg('@canboat/canboatjs', loc('3.20.0', 'up-to-date'), null, '3.20.0'),
        pkg('@signalk/streams', loc('6.6.0', 'unknown'), null, null, null),
      ]),
    );
    const res = await probeDependencyDrift();
    expect(res.status).toBe('unknown');
    expect(res.message).toMatch(/comparison incomplete/);
    expect(res.message).toMatch(/1 up-to-date/);
    expect(res.message).toMatch(/1 not compared yet/);
    expect(res.message).not.toMatch(/no major drift/);
  });

  it('is unknown when one LOCATION is uncompared even though its sibling ranks worse', async () => {
    // Regression guard: hasUnknown once went through worstOf(), where a
    // sibling location's minor outranks unknown and hid it — minor + unknown
    // reported ok and claimed "no major drift" for a location nobody compared.
    await saveDriftReport(
      report([
        pkg('@signalk/server-api', loc('2.24.0', 'minor'), loc('not-semver', 'unknown'), '2.30.0'),
      ]),
    );
    const res = await probeDependencyDrift();
    expect(res.status).toBe('unknown');
    expect(res.message).toMatch(/comparison incomplete/);
    expect(res.message).not.toMatch(/no major drift/);
  });

  it('a known major still warns even when another package is uncompared', async () => {
    await saveDriftReport(
      report([
        pkg('@signalk/streams', loc('5.1.3', 'major'), null, '6.8.0'),
        pkg('@canboat/ts-pgns', loc('1.11.18', 'unknown'), null, null, null),
      ]),
    );
    const res = await probeDependencyDrift();
    expect(res.status).toBe('warn');
    expect(res.message).toMatch(/@signalk\/streams \(image\) 5\.1\.3 → 6\.8\.0/);
  });

  it('is unknown when the report tracks no packages', async () => {
    await saveDriftReport(report([]));
    const res = await probeDependencyDrift();
    expect(res.status).toBe('unknown');
    expect(res.message).toMatch(/no tracked packages/);
  });
});
