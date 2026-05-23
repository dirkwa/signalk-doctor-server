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
    const app = await createServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/session' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { token: string };
      expect(body.token).toBe('test-token-xyz');
    } finally {
      await app.close();
    }
  });

  it('returns 503 when the token file is missing', async () => {
    const saved = process.env.TOKEN_PATH;
    process.env.TOKEN_PATH = '/tmp/this-path-definitely-does-not-exist-xyz';
    const app = await createServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/session' });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
      process.env.TOKEN_PATH = saved;
    }
  });
});
