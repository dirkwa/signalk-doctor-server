import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDriftReport, saveDriftReport } from '../src/drift/store.js';
import type { DriftReport } from '../src/drift/types.js';

describe('drift store', () => {
  let dir: string;
  const prev = process.env.DOCTOR_DATA;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'drift-store-'));
    process.env.DOCTOR_DATA = dir;
  });

  afterEach(async () => {
    if (prev === undefined) delete process.env.DOCTOR_DATA;
    else process.env.DOCTOR_DATA = prev;
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when no report exists yet', async () => {
    expect(await loadDriftReport()).toBeNull();
  });

  it('roundtrips a written report', async () => {
    const report: DriftReport = {
      signalkImageTag: 'ghcr.io/signalk/signalk-server:2.24.0',
      lastScannedAt: '2026-05-24T00:00:00.000Z',
      lastSuccessfulScanAt: '2026-05-24T00:00:00.000Z',
      online: true,
      lastFetchError: null,
      packages: [
        {
          name: '@canboat/canboatjs',
          image: { installed: '3.16.3', classification: 'minor' },
          dataDir: { installed: '3.10.0', classification: 'minor' },
          latest: '3.19.0',
          etag: 'W/"abc"',
          lastFetchedAt: '2026-05-24T00:00:00.000Z',
        },
      ],
    };
    await saveDriftReport(report);
    const loaded = await loadDriftReport();
    expect(loaded).toEqual(report);
  });

  it('migrates a pre-v0.8 single-version package entry to the two-location shape', async () => {
    // Old entries carried one first-hit-wins `installed` version whose
    // location (image vs data dir) is ambiguous in hindsight. The migration
    // keeps what the registry would have to rebuild (latest/etag/
    // lastFetchedAt — precious offline) and drops the ambiguous version;
    // the next scan refills both locations from local container reads.
    const oldReport = {
      signalkImageTag: 'ghcr.io/dirkwa/signalk-server:dirkwa-3e651e9',
      lastScannedAt: '2026-05-24T00:00:00.000Z',
      lastSuccessfulScanAt: '2026-05-24T00:00:00.000Z',
      online: true,
      lastFetchError: null,
      packages: [
        {
          name: '@signalk/server-api',
          installed: '2.24.0',
          latest: '2.30.0',
          classification: 'minor',
          etag: 'W/"abc"',
          lastFetchedAt: '2026-05-24T00:00:00.000Z',
        },
      ],
    };
    await writeFile(join(dir, 'drift.json'), JSON.stringify(oldReport, null, 2));
    const loaded = await loadDriftReport();
    expect(loaded?.packages).toEqual([
      {
        name: '@signalk/server-api',
        image: null,
        dataDir: null,
        latest: '2.30.0',
        etag: 'W/"abc"',
        lastFetchedAt: '2026-05-24T00:00:00.000Z',
      },
    ]);
  });

  it('drops malformed package entries and sanitizes bad location objects', async () => {
    const report = {
      signalkImageTag: null,
      lastScannedAt: '2026-05-24T00:00:00.000Z',
      lastSuccessfulScanAt: null,
      online: false,
      lastFetchError: null,
      packages: [
        { latest: '1.0.0' }, // no name → dropped
        {
          name: '@canboat/ts-pgns',
          image: { installed: '1.11.18', classification: 'not-a-classification' },
          dataDir: { classification: 'minor' }, // no installed → null
          latest: '1.11.18',
          etag: null,
          lastFetchedAt: null,
        },
      ],
    };
    await writeFile(join(dir, 'drift.json'), JSON.stringify(report, null, 2));
    const loaded = await loadDriftReport();
    expect(loaded?.packages).toEqual([
      {
        name: '@canboat/ts-pgns',
        image: { installed: '1.11.18', classification: 'unknown' },
        dataDir: null,
        latest: '1.11.18',
        etag: null,
        lastFetchedAt: null,
      },
    ]);
  });

  it('migrates a pre-v0.7.5 report missing lastFetchError → null', async () => {
    // What the file looked like before lastFetchError landed.
    const oldReport = {
      signalkImageTag: 'ghcr.io/signalk/signalk-server:2.24.0',
      lastScannedAt: '2026-05-24T00:00:00.000Z',
      lastSuccessfulScanAt: '2026-05-24T00:00:00.000Z',
      online: true,
      packages: [],
    };
    await writeFile(join(dir, 'drift.json'), JSON.stringify(oldReport, null, 2));
    const loaded = await loadDriftReport();
    expect(loaded).not.toBeNull();
    expect(loaded?.lastFetchError).toBeNull();
  });

  it('migrates a retired HTTP-era lastFetchError reason forward', async () => {
    // Before the filesystem-reader swap the scanner wrote HTTP-era reasons
    // (network, no-token, auth, http, not-found, bad-payload). An existing
    // drift.json carrying one must still load — and the reason rewrites to a
    // current value — so a boat mid-outage at upgrade keeps its packages.
    const oldReport = {
      signalkImageTag: null,
      lastScannedAt: '2026-05-24T00:00:00.000Z',
      lastSuccessfulScanAt: null,
      online: false,
      lastFetchError: { reason: 'network', detail: 'ECONNREFUSED' },
      packages: [],
    };
    await writeFile(join(dir, 'drift.json'), JSON.stringify(oldReport, null, 2));
    const loaded = await loadDriftReport();
    expect(loaded).not.toBeNull();
    expect(loaded?.lastFetchError?.reason).toBe('unreachable');
    expect(loaded?.lastFetchError?.detail).toBe('ECONNREFUSED');
  });

  it('maps a retired not-found reason to runtime', async () => {
    const oldReport = {
      signalkImageTag: null,
      lastScannedAt: '2026-05-24T00:00:00.000Z',
      lastSuccessfulScanAt: null,
      online: false,
      lastFetchError: { reason: 'not-found', detail: 'HTTP 404' },
      packages: [],
    };
    await writeFile(join(dir, 'drift.json'), JSON.stringify(oldReport, null, 2));
    const loaded = await loadDriftReport();
    expect(loaded).not.toBeNull();
    expect(loaded?.lastFetchError?.reason).toBe('runtime');
    expect(loaded?.lastFetchError?.detail).toBe('HTTP 404');
  });

  it('refuses to load a report with a malformed lastFetchError reason', async () => {
    // A hand-edited or corrupted file with a reason outside the known
    // set must not leak through — the UI's FETCH_ERROR_GUIDANCE[reason]
    // lookup would otherwise produce undefined and crash at render time.
    const badReport = {
      signalkImageTag: null,
      lastScannedAt: '2026-05-24T00:00:00.000Z',
      lastSuccessfulScanAt: null,
      online: false,
      lastFetchError: { reason: 'invalid-reason', detail: 'whatever' },
      packages: [],
    };
    await writeFile(join(dir, 'drift.json'), JSON.stringify(badReport, null, 2));
    expect(await loadDriftReport()).toBeNull();
  });

  it('refuses to load a report whose lastFetchError is not an object', async () => {
    const badReport = {
      signalkImageTag: null,
      lastScannedAt: '2026-05-24T00:00:00.000Z',
      lastSuccessfulScanAt: null,
      online: false,
      lastFetchError: 'wrong shape',
      packages: [],
    };
    await writeFile(join(dir, 'drift.json'), JSON.stringify(badReport, null, 2));
    expect(await loadDriftReport()).toBeNull();
  });
});
