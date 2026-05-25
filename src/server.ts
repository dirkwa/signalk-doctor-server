import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { registerHealthRoutes } from './routes/health.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerProbeRoutes } from './routes/probes.js';
import { registerRecoverRoutes } from './routes/recover.js';
import { registerLogStreamRoutes } from './routes/logs-stream.js';
import { registerSelfRoutes } from './routes/self.js';
import { registerDriftRoutes } from './routes/drift.js';
import { registerInstallerRoutes } from './routes/installer.js';
import { DriftScheduler } from './drift/scheduler.js';

const here = dirname(fileURLToPath(import.meta.url));

// Webapp build output directory. In the container, dist/server.js runs
// from /app/dist so `..` resolves to /app, matching the Dockerfile's
// COPY destination. In dev (`tsx watch src/server.ts`), `..` resolves
// to the repo root, picking up `webapp-dist/` from `npm run build:webapp`.
const WEBAPP_ROOT = process.env.WEBAPP_ROOT ?? resolve(here, '..', 'webapp-dist');

export async function createServer(): Promise<{
  app: FastifyInstance;
  driftScheduler: DriftScheduler;
}> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  const driftScheduler = new DriftScheduler(app.log);

  // API routes first so they take precedence over the static fallback.
  await registerHealthRoutes(app);
  await registerSessionRoutes(app);
  await registerProbeRoutes(app);
  await registerRecoverRoutes(app);
  await registerLogStreamRoutes(app);
  await registerSelfRoutes(app);
  await registerDriftRoutes(app, driftScheduler);
  await registerInstallerRoutes(app);

  // Serve the webapp at /. Without this, opening the Doctor Console URL
  // in a browser hits Fastify's default 404 for GET /.
  if (existsSync(WEBAPP_ROOT)) {
    await app.register(fastifyStatic, {
      root: resolve(WEBAPP_ROOT),
      prefix: '/',
      decorateReply: false,
    });
  }

  return { app, driftScheduler };
}
