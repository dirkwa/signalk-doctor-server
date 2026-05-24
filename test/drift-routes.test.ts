import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { __resetTokenCacheForTests } from '../src/auth.js';
import { saveDriftReport } from '../src/drift/store.js';
import type { DriftReport } from '../src/drift/types.js';

const FIXTURE: DriftReport = {
  signalkImageTag: 'ghcr.io/dirkwa/signalk-server:2.27.0',
  lastScannedAt: '2026-05-24T00:00:00.000Z',
  lastSuccessfulScanAt: '2026-05-24T00:00:00.000Z',
  online: true,
  packages: [
    {
      name: '@canboat/canboatjs',
      installed: '3.16.3',
      latest: '3.19.0',
      classification: 'minor',
      etag: null,
      lastFetchedAt: '2026-05-24T00:00:00.000Z',
    },
  ],
};

describe('drift routes', () => {
  let dir: string;
  const prevDoctorData = process.env.DOCTOR_DATA;
  const prevTokenPath = process.env.TOKEN_PATH;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'drift-routes-'));
    process.env.DOCTOR_DATA = dir;
    const tokenPath = join(dir, 'token');
    await writeFile(tokenPath, 'sekret\n', 'utf8');
    process.env.TOKEN_PATH = tokenPath;
    __resetTokenCacheForTests();
    await saveDriftReport(FIXTURE);
  });

  afterAll(async () => {
    if (prevDoctorData === undefined) delete process.env.DOCTOR_DATA;
    else process.env.DOCTOR_DATA = prevDoctorData;
    if (prevTokenPath === undefined) delete process.env.TOKEN_PATH;
    else process.env.TOKEN_PATH = prevTokenPath;
    await rm(dir, { recursive: true, force: true });
  });

  it('GET /api/drift returns the persisted report unauthenticated', async () => {
    const { app, driftScheduler } = await createServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/drift' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as DriftReport;
      expect(body).toEqual(FIXTURE);
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });

  it('GET /api/drift returns an empty report when no scan has run', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'drift-empty-'));
    const saved = process.env.DOCTOR_DATA;
    process.env.DOCTOR_DATA = emptyDir;
    const { app, driftScheduler } = await createServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/drift' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as DriftReport;
      expect(body.packages).toEqual([]);
      expect(body.online).toBe(false);
      expect(body.signalkImageTag).toBeNull();
    } finally {
      driftScheduler.stop();
      await app.close();
      if (saved === undefined) delete process.env.DOCTOR_DATA;
      else process.env.DOCTOR_DATA = saved;
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('POST /api/drift/refresh requires bearer token', async () => {
    const { app, driftScheduler } = await createServer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/drift/refresh' });
      expect(res.statusCode).toBe(401);
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });
});
