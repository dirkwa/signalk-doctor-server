import type { FastifyInstance } from 'fastify';
import { requireToken } from '../auth.js';
import type { DriftScheduler } from '../drift/scheduler.js';
import { loadDriftReport } from '../drift/store.js';
import type { DriftReport } from '../drift/types.js';
import { runDataDirHeal, type HealResult, type HealRunDeps } from '../drift/heal.js';
import { findRunningHealJob, getHealJob, startHealJob } from '../drift/heal-jobs.js';
import { acquireMutex, readLock, MutexBusyError } from '../mutex.js';

export type HealRunner = (deps: HealRunDeps) => Promise<HealResult>;

function emptyReport(): DriftReport {
  return {
    signalkImageTag: null,
    lastScannedAt: new Date(0).toISOString(),
    lastSuccessfulScanAt: null,
    online: false,
    lastFetchError: null,
    packages: [],
  };
}

export async function registerDriftRoutes(
  app: FastifyInstance,
  scheduler: DriftScheduler,
  // Injectable for route tests (a controllable runner); production uses the
  // real engine.
  healRunner: HealRunner = runDataDirHeal,
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

  // Start a data-dir heal (`npm update` of the drifting plugin-tree copies
  // inside signalk-server) as an async job: 202 + jobId immediately, poll
  // the GET below. Synchronous would trip the plugin proxy's 15s header
  // watchdog on any real npm run (same rationale as bug-report).
  app.post('/api/drift/heal', { preHandler: requireToken }, async (_req, reply) => {
    // Reuse BEFORE the lock pre-check: a running heal holds the operation
    // lock itself, so checking the lock first would answer a duplicate POST
    // with 409 off our own lock instead of returning the in-flight job.
    const running = findRunningHealJob();
    if (running) {
      reply.code(202);
      return { ...running, status: 'running', reused: true };
    }
    // Fast-path courtesy check so the operator sees "updater is busy" now
    // instead of a job that errors later. The authoritative gate is the
    // acquireMutex inside the job — this pre-check is unavoidably racy.
    const lock = await readLock();
    if (lock) {
      reply.code(409);
      return { error: 'another operation is in progress', lock };
    }
    const started = startHealJob(async (): Promise<HealResult> => {
      let handle;
      try {
        handle = await acquireMutex('heal-plugin-deps');
      } catch (err) {
        if (err instanceof MutexBusyError) {
          const now = new Date().toISOString();
          return {
            ok: false,
            reason: 'exec',
            detail:
              `operation lock held by ${err.lock.owner}/${err.lock.operation} ` +
              `since ${err.lock.startedAt} — wait for it to finish and retry`,
            startedAt: now,
            finishedAt: now,
            durationMs: 0,
          };
        }
        throw err;
      }
      let result: HealResult | null = null;
      try {
        result = await healRunner({ rescan: () => scheduler.refreshNow() });
        return result;
      } finally {
        // CC-5: when npm could not be proven stopped, the lock stays in
        // place so no other mutation can race the still-running npm. The
        // operator waits or force-clears via the recovery surface; the
        // result's detail says so.
        const retainLock = result !== null && !result.ok && result.lockRetained === true;
        if (!retainLock) await handle.release();
      }
    });
    reply.code(202);
    return started;
  });

  // Read-only job status — unauthenticated per CC-2; the random jobId is
  // the capability.
  app.get<{ Params: { jobId: string } }>('/api/drift/heal/:jobId', async (req, reply) => {
    const job = getHealJob(req.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: 'no such heal job' };
    }
    return job;
  });
}
