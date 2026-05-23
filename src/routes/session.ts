import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';

/**
 * Hand the doctor webapp the bearer token it needs to call /api/recover.
 *
 * The token is already a localhost-scoped secret (mode 0600 in
 * ~/.signalk-doctor/token) and the engine listens on a single
 * configured PublishPort. Any client that has already reached the
 * engine over that port has crossed the same trust boundary the
 * token was meant to gate. Echoing it back to the SPA at boot time
 * lets the page issue authenticated requests without baking the
 * token into static assets or relying on a separate cookie-setting
 * hop through the SignalK plugin.
 */
export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/session', async (_req, reply) => {
    // Resolve TOKEN_PATH at request time, not module-load time, so
    // tests can swap it via process.env between server instantiations.
    const tokenPath = process.env.TOKEN_PATH ?? '/data/token';
    try {
      const token = (await readFile(tokenPath, 'utf8')).trim();
      if (!token) {
        reply.code(503);
        return { error: 'auth not initialized: empty token file' };
      }
      return { token };
    } catch (err) {
      reply.code(503);
      return {
        error: 'auth not initialized: token file unreadable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
