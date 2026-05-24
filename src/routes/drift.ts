import type { FastifyInstance } from 'fastify';
import { requireToken } from '../auth.js';
import type { DriftScheduler } from '../drift/scheduler.js';
import { loadDriftReport } from '../drift/store.js';
import type { DriftReport } from '../drift/types.js';

function emptyReport(): DriftReport {
  return {
    signalkImageTag: null,
    lastScannedAt: new Date(0).toISOString(),
    lastSuccessfulScanAt: null,
    online: false,
    packages: [],
  };
}

export async function registerDriftRoutes(
  app: FastifyInstance,
  scheduler: DriftScheduler,
): Promise<void> {
  app.get('/api/drift', async () => {
    return (await loadDriftReport()) ?? emptyReport();
  });

  app.post('/api/drift/refresh', { preHandler: requireToken }, async () => {
    // runOnce() catches and logs all errors internally; refreshNow() won't
    // throw in practice. If it ever did, Fastify's default error handler
    // would format the response — don't try/catch + re-respond here.
    await scheduler.refreshNow();
    return (await loadDriftReport()) ?? emptyReport();
  });
}
