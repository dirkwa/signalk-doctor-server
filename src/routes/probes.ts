import type { FastifyInstance } from 'fastify';
import { runAllProbes } from '../probes/runner.js';

export async function registerProbeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/probes', async () => runAllProbes());
}
