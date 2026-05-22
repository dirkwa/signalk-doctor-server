import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '../types.js';
import { resolveRuntime } from '../podman/client.js';

const startedAt = Date.now();

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (): Promise<HealthResponse> => {
    const runtime = await resolveRuntime();
    return {
      ok: runtime !== null,
      runtime: runtime?.kind ?? 'unknown',
      socketPath: runtime?.socketPath,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
  });
}
