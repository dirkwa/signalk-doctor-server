import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { registerHealthRoutes } from './routes/health.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerProbeRoutes } from './routes/probes.js';
import { registerRecoverRoutes } from './routes/recover.js';
import { registerLogStreamRoutes } from './routes/logs-stream.js';

// Webapp directory inside the container image. Build copies webapp/ to
// /app/webapp; the env var lets dev mode point at the source tree.
const WEBAPP_ROOT = process.env.WEBAPP_ROOT ?? '/app/webapp';

export async function createServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  // API routes first so they take precedence over the static fallback.
  await registerHealthRoutes(app);
  await registerSessionRoutes(app);
  await registerProbeRoutes(app);
  await registerRecoverRoutes(app);
  await registerLogStreamRoutes(app);

  // Serve the webapp at /. Without this, opening the Doctor Console URL
  // in a browser hits Fastify's default 404 for GET / — confusing UX.
  // The placeholder index.html will be replaced by a real Vite+React
  // build in a later phase; this just lays down the route.
  if (existsSync(WEBAPP_ROOT)) {
    await app.register(fastifyStatic, {
      root: resolve(WEBAPP_ROOT),
      prefix: '/',
      decorateReply: false,
    });
  }

  return app;
}
