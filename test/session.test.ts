import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';

describe('GET /api/session', () => {
  let dir: string;
  const previousTokenPath = process.env.TOKEN_PATH;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doctor-session-'));
    const tokenPath = join(dir, 'token');
    await writeFile(tokenPath, 'test-token-xyz\n', 'utf8');
    process.env.TOKEN_PATH = tokenPath;
  });

  afterAll(async () => {
    if (previousTokenPath === undefined) delete process.env.TOKEN_PATH;
    else process.env.TOKEN_PATH = previousTokenPath;
    await rm(dir, { recursive: true, force: true });
  });

  it('echoes back the bearer token for the SPA to use', async () => {
    const { app, driftScheduler } = await createServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/session' });
      expect(res.statusCode).toBe(200);
      // Bearer tokens must not be cached by intermediaries or the
      // browser disk cache.
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['pragma']).toBe('no-cache');
      const body = res.json() as { token: string };
      expect(body.token).toBe('test-token-xyz');
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });

  it('returns 503 when the token file is missing', async () => {
    const saved = process.env.TOKEN_PATH;
    // Point at a guaranteed-missing path inside the temp dir rather
    // than a hardcoded /tmp/... so the test doesn't depend on the
    // host environment.
    process.env.TOKEN_PATH = join(dir, 'this-file-does-not-exist');
    const { app, driftScheduler } = await createServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/session' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: string; detail?: unknown };
      expect(body.error).toMatch(/token file unreadable/);
      // We must NOT leak the filesystem path back to the client.
      expect(body).not.toHaveProperty('detail');
    } finally {
      driftScheduler.stop();
      await app.close();
      process.env.TOKEN_PATH = saved;
    }
  });
});
