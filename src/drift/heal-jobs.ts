import { randomUUID } from 'node:crypto';
import type { HealResult } from './heal.js';

// Same job-registry rationale as bug-report-jobs.ts: `npm update` on a
// cold/busy boat routinely outlives the signalk-doctor plugin proxy's 15s
// header watchdog, so a synchronous POST would surface as "HTTP 502" while
// the update quietly succeeds. POST returns 202 + jobId immediately; the
// webapp polls. Single Fastify process → an in-memory map is the registry.

export type HealJobStatus = 'running' | 'done' | 'error';

interface RunningJob {
  status: 'running';
  startedAt: string;
}

interface FinishedJob {
  status: 'done' | 'error';
  startedAt: string;
  finishedAt: string;
  result: HealResult;
}

export type HealJob = RunningJob | FinishedJob;

const MAX_JOBS = 8;
const jobs = new Map<string, HealJob>();

function pruneJobs(): void {
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    if (oldest === undefined) break;
    jobs.delete(oldest);
  }
}

function findRunningJobId(): string | null {
  for (const [id, job] of jobs) {
    if (job.status === 'running') return id;
  }
  return null;
}

export interface HealStartResult {
  jobId: string;
  status: HealJobStatus;
  startedAt: string;
  /** True when an in-flight heal was returned instead of starting a second
   *  npm run against the same tree. */
  reused: boolean;
}

/** The currently running heal, if any — the route checks this BEFORE the
 *  mutex pre-check, because a running heal HOLDS the operation lock and a
 *  duplicate POST must reuse it (202), not bounce off its own lock (409). */
export function findRunningHealJob(): { jobId: string; startedAt: string } | null {
  const id = findRunningJobId();
  if (id === null) return null;
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return null;
  return { jobId: id, startedAt: job.startedAt };
}

/** Start a heal as a fire-and-forget job. A second POST while one runs
 *  returns the running job — two concurrent `npm update`s on one
 *  node_modules tree corrupt it. */
export function startHealJob(run: () => Promise<HealResult>): HealStartResult {
  const running = findRunningJobId();
  if (running) {
    const job = jobs.get(running);
    if (job && job.status === 'running') {
      return { jobId: running, status: 'running', startedAt: job.startedAt, reused: true };
    }
  }

  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  jobs.set(jobId, { status: 'running', startedAt });
  pruneJobs();

  // Promise.resolve().then(run) so a SYNCHRONOUS throw from run() lands in
  // the rejection arm instead of escaping startHealJob — an escaped throw
  // would leave the job 'running' forever and every future start would
  // reuse the corpse.
  void Promise.resolve()
    .then(run)
    .then(
      (result) => finalize(jobId, result),
      (err: unknown) => {
        // run() is expected to resolve with a categorized HealResult; this arm
        // catches unexpected throws (e.g. MutexBusyError) so a job can never
        // stay 'running' forever.
        const finishedAt = new Date().toISOString();
        finalize(jobId, {
          ok: false,
          reason: 'exec',
          detail: err instanceof Error ? err.message : String(err),
          startedAt,
          finishedAt,
          durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        });
      },
    );

  return { jobId, status: 'running', startedAt, reused: false };
}

function finalize(jobId: string, result: HealResult): void {
  const existing = jobs.get(jobId);
  if (!existing) return; // pruned out from under us
  jobs.set(jobId, {
    status: result.ok ? 'done' : 'error',
    startedAt: existing.startedAt,
    finishedAt: new Date().toISOString(),
    result,
  });
}

export function getHealJob(jobId: string): HealJob | undefined {
  return jobs.get(jobId);
}

/** Test-only: clear all job state between cases. */
export function __resetHealJobsForTests(): void {
  jobs.clear();
}
