import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the busctl shell-out so the route's success path doesn't need a real
// host bus. We assert the route calls restartUnit with the signalk-server
// unit and nothing else (no daemon-reload for a plain restart). vi.hoisted
// lets the spies exist before the hoisted vi.mock factory references them.
const { restartUnit, daemonReload } = vi.hoisted(() => ({
  restartUnit: vi.fn(async () => undefined),
  daemonReload: vi.fn(async () => undefined),
}));
vi.mock('../src/dbus/systemd-user.js', () => ({
  restartUnit,
  daemonReload,
  startUnit: vi.fn(),
  stopUnit: vi.fn(),
}));

import { createServer } from '../src/server.js';
import { __resetTokenCacheForTests } from '../src/auth.js';

const TOKEN = 'sekret';

async function withApp(
  fn: (app: Awaited<ReturnType<typeof createServer>>['app']) => Promise<void>,
) {
  const { app, driftScheduler } = await createServer();
  try {
    await fn(app);
  } finally {
    driftScheduler.stop();
    await app.close();
  }
}

describe('restart routes', () => {
  let dir: string;
  const prevTokenPath = process.env.TOKEN_PATH;
  const prevLock = process.env.OPERATION_LOCK;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restart-routes-'));
    const tokenPath = join(dir, 'token');
    await writeFile(tokenPath, `${TOKEN}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(tokenPath, 0o600);
    process.env.TOKEN_PATH = tokenPath;
    // Point the shared operation lock (CC-5) into the temp dir so the mutex
    // can acquire it without the container's /updater-data mount.
    process.env.OPERATION_LOCK = join(dir, 'operation.lock');
    __resetTokenCacheForTests();
  });

  afterAll(async () => {
    if (prevTokenPath === undefined) delete process.env.TOKEN_PATH;
    else process.env.TOKEN_PATH = prevTokenPath;
    if (prevLock === undefined) delete process.env.OPERATION_LOCK;
    else process.env.OPERATION_LOCK = prevLock;
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    restartUnit.mockClear();
    daemonReload.mockClear();
  });

  it('rejects an unauthenticated restart (CC-2)', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'POST', url: '/api/restart/signalk-server' });
      expect(res.statusCode).toBe(401);
      expect(restartUnit).not.toHaveBeenCalled();
    });
  });

  it('restarts signalk-server with a valid token', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/restart/signalk-server',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, unit: 'signalk-server.service' });
      expect(restartUnit).toHaveBeenCalledWith('signalk-server.service');
      // A plain restart is not a Quadlet change — no daemon-reload.
      expect(daemonReload).not.toHaveBeenCalled();
    });
  });

  it('surfaces a busctl failure as 500 without leaking the raw message', async () => {
    // The raw busctl/systemd message can carry host internals (unit paths,
    // DBus addresses); the client must get a generic message instead.
    restartUnit.mockRejectedValueOnce(
      new Error('busctl RestartUnit failed: /org/freedesktop/systemd1 denied'),
    );
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/restart/signalk-server',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(500);
      const body = res.json() as { error: string };
      expect(body.error).toBe('failed to restart signalk-server.service');
      expect(body.error).not.toContain('busctl');
      expect(body.error).not.toContain('freedesktop');
    });
  });

  it('refuses to restart while the shared operation lock is held (CC-5)', async () => {
    // A held lock must block the mutation, return the wait-or-force-clear
    // response with the lock holder, and NOT touch the unit.
    await writeFile(
      join(dir, 'operation.lock'),
      JSON.stringify({ owner: 'updater', operation: 'switch', startedAt: '2026-07-17T00:00:00Z' }),
    );
    try {
      await withApp(async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/restart/signalk-server',
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(409);
        const body = res.json() as {
          lock: { owner: string; operation: string };
          hint: string;
        };
        expect(body.lock.owner).toBe('updater');
        expect(body.lock.operation).toBe('switch');
        // CC-5: the conflict response must tell the operator what to do.
        expect(body.hint).toMatch(/wait/i);
        expect(body.hint).toMatch(/force-clear/i);
        expect(restartUnit).not.toHaveBeenCalled();
      });
    } finally {
      await rm(join(dir, 'operation.lock'), { force: true });
    }
  });
});
