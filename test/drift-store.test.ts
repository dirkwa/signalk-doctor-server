import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
      packages: [
        {
          name: '@canboat/canboatjs',
          installed: '3.16.3',
          latest: '3.19.0',
          classification: 'minor',
          etag: 'W/"abc"',
          lastFetchedAt: '2026-05-24T00:00:00.000Z',
        },
      ],
    };
    await saveDriftReport(report);
    const loaded = await loadDriftReport();
    expect(loaded).toEqual(report);
  });
});
