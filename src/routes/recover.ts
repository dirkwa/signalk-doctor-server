import type { FastifyInstance } from 'fastify';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readLastGood } from '../quadlet/rewriter.js';
import { recoverAll, recoverOne } from '../recovery/restore.js';
import { requireToken } from '../auth.js';
import { withMutex, MutexBusyError } from '../mutex.js';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const SNAPSHOT_DIR = join(DATA_DIR, 'snapshots');

export async function registerRecoverRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/snapshots', async () => {
    const entries = await readdir(SNAPSHOT_DIR).catch(() => [] as string[]);
    const out: Array<{ name: string; path: string; mtime: string; size: number }> = [];
    for (const e of entries) {
      const p = join(SNAPSHOT_DIR, e);
      const s = await stat(p);
      out.push({ name: e, path: p, mtime: new Date(s.mtimeMs).toISOString(), size: s.size });
    }
    out.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return { count: out.length, snapshots: out };
  });

  app.get('/api/last-good', async () => {
    return (await readLastGood()) ?? { updatedAt: null, quadlets: {} };
  });

  app.post('/api/recover', { preHandler: requireToken }, async (_req, reply) => {
    try {
      return await withMutex('recover', () => recoverAll());
    } catch (err) {
      if (err instanceof MutexBusyError) {
        reply.code(409);
        return { error: err.message, lock: err.lock };
      }
      reply.code(500);
      return { error: err instanceof Error ? err.message : 'unknown error' };
    }
  });

  app.post<{ Body: { quadlet?: string } }>(
    '/api/recover/updater',
    { preHandler: requireToken },
    async (_req, reply) => {
      try {
        return await withMutex('recover', () => recoverOne('signalk-updater-server.container'));
      } catch (err) {
        if (err instanceof MutexBusyError) {
          reply.code(409);
          return { error: err.message, lock: err.lock };
        }
        reply.code(500);
        return { error: err instanceof Error ? err.message : 'unknown error' };
      }
    },
  );
}
