import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';

/**
 * Hand the webapp the bearer token it needs to call mutating endpoints.
 *
 * The token is already a localhost-scoped secret (mode 0600 in
 * ~/.signalk-doctor/token) and the engine listens on a single
 * configured PublishPort (127.0.0.1 by default, or 0.0.0.0 when the
 * installer was launched with SIGNALK_LAN_EXPOSE=true). Any client
 * that has already reached the engine over that port has crossed the
 * same trust boundary the token was meant to gate. Echoing it back
 * to the SPA at boot time lets the page issue authenticated requests
 * without baking the token into static assets or relying on a
 * separate cookie-setting hop through the SignalK plugin.
 */
export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/session', async (_req, reply) => {
    // Bearer token must not be cached by any intermediary or by the
    // browser disk cache. Same guidance as RFC6750 §5.3 — bearer
    // tokens travelling over HTTP shouldn't end up in proxy logs or
    // back/forward navigation buffers.
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');

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
      // The catch path can be reached because the file is missing,
      // the engine is running with the wrong volume, or fs permissions
      // are wrong. Log the raw error server-side; return a generic
      // message client-side so we don't leak filesystem paths.
      app.log.warn({ err, tokenPath }, 'failed to read session token');
      reply.code(503);
      return { error: 'auth not initialized: token file unreadable' };
    }
  });
}
