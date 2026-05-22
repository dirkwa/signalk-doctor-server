import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './routes/health.js';
import { registerProbeRoutes } from './routes/probes.js';
import { registerRecoverRoutes } from './routes/recover.js';

export async function createServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await registerHealthRoutes(app);
  await registerProbeRoutes(app);
  await registerRecoverRoutes(app);

  return app;
}
