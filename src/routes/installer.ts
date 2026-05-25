import type { FastifyInstance } from 'fastify';
import { refreshInstaller, readInstallerStatus } from '../installer/refresh.js';
import { requireToken } from '../auth.js';
import { withMutex, MutexBusyError } from '../mutex.js';

export async function registerInstallerRoutes(app: FastifyInstance): Promise<void> {
  // Read-only: what the doctor currently knows about the host installer.
  // Unauthenticated per CC-2 (read-only probe). Operators and the doctor UI
  // both call this to render "needs refresh?" affordances before any token
  // exchange.
  app.get('/api/installer/status', async () => {
    return readInstallerStatus();
  });

  // Mutating: fetch latest payload from GitHub Pages, snapshot prior
  // contents, write new bytes atomically. Token-gated per CC-2; mutex-
  // shared with switch/self-update/recover per CC-5 so a refresh cannot
  // race a Quadlet rewrite or a recovery.
  app.post('/api/installer/refresh', { preHandler: requireToken }, async (_req, reply) => {
    try {
      return await withMutex('installer-refresh', () => refreshInstaller());
    } catch (err) {
      if (err instanceof MutexBusyError) {
        reply.code(409);
        return { error: err.message, lock: err.lock };
      }
      reply.code(500);
      return { error: err instanceof Error ? err.message : 'unknown error' };
    }
  });
}
