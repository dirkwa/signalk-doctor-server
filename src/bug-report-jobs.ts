import { randomUUID } from 'node:crypto';
import { generateBugReport, type BugReportResult, type SpawnLogger } from './bug-report.js';

// Why a job registry instead of a synchronous POST:
//
// The host `signalk bug-report` script walks ~24h of journal, inspects
// every signalk-* container, redacts settings.json, and tars the lot —
// on a cold/busy boat that routinely exceeds the signalk-doctor plugin
// proxy's 15s header-arrival watchdog. A synchronous POST never sends
// response headers until the whole collection finishes, so the proxy
// destroys the socket and the browser sees "HTTP 502" *every time*, even
// though a valid tarball lands out-of-band. We split the work: POST
// starts a fire-and-forget job and returns 202 immediately (headers in
// <1s), the webapp polls status, and downloads the tarball when done.
//
// Single-process, in-memory registry. The doctor is one container with
// one Fastify process; there's no horizontal scale to coordinate across.
// A restart loses in-flight job state, but the host transient unit keeps
// running independently and the tarball still lands under
// ~/.signalk-doctor/bug-reports/ for offline retrieval — same durability
// guarantee the synchronous path had.

export type BugReportJobStatus = 'running' | 'done' | 'error';

interface RunningJob {
  status: 'running';
  startedAt: string;
}

interface DoneJob {
  status: 'done';
  startedAt: string;
  finishedAt: string;
  result: Extract<BugReportResult, { ok: true }>;
}

interface ErrorJob {
  status: 'error';
  startedAt: string;
  finishedAt: string;
  result: Extract<BugReportResult, { ok: false }>;
}

type Job = RunningJob | DoneJob | ErrorJob;

// Keep a small bounded history so the webapp can still poll a job that
// finished a moment ago (poll cadence vs completion is a race). We only
// ever expect one bug-report at a time, but bounding the map keeps a
// long-lived doctor from leaking job records across many manual runs.
const MAX_JOBS = 8;
const jobs = new Map<string, Job>();

/** Insertion-ordered prune: drop the oldest entries once we exceed the
 *  cap. Map preserves insertion order, so the first keys are the oldest. */
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

export interface StartResult {
  jobId: string;
  status: BugReportJobStatus;
  startedAt: string;
  /** True when an existing in-flight job was returned instead of
   *  spawning a second host collector. */
  reused: boolean;
}

/** Start a bug-report collection as a fire-and-forget job and return its
 *  id immediately. If a job is already running we return *that* job
 *  rather than spawning a second host `signalk bug-report` (two parallel
 *  collectors would fight over the same output dir and double the load on
 *  an already-struggling boat). */
export function startBugReportJob(log?: SpawnLogger): StartResult {
  const running = findRunningJobId();
  if (running) {
    const job = jobs.get(running);
    // job is guaranteed running here, but narrow for strict TS.
    if (job && job.status === 'running') {
      return { jobId: running, status: 'running', startedAt: job.startedAt, reused: true };
    }
  }

  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  jobs.set(jobId, { status: 'running', startedAt });
  pruneJobs();

  // Fire-and-forget. generateBugReport never rejects (it returns a
  // categorized BugReportResult), but guard anyway so an unexpected throw
  // can't leave the job stuck in 'running' forever.
  void generateBugReport(log).then(
    (result) => {
      finalize(jobId, result);
    },
    (err: unknown) => {
      finalize(jobId, {
        ok: false,
        reason: 'spawn-failed',
        detail: err instanceof Error ? err.message : String(err),
        durationMs: 0,
      });
    },
  );

  return { jobId, status: 'running', startedAt, reused: false };
}

function finalize(jobId: string, result: BugReportResult): void {
  const finishedAt = new Date().toISOString();
  const existing = jobs.get(jobId);
  // If the job was pruned out from under us (many parallel runs), drop
  // the result; the tarball still landed on disk for offline retrieval.
  if (!existing) return;
  if (result.ok) {
    jobs.set(jobId, { status: 'done', startedAt: existing.startedAt, finishedAt, result });
  } else {
    jobs.set(jobId, { status: 'error', startedAt: existing.startedAt, finishedAt, result });
  }
}

export function getBugReportJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

/** Test-only: clear all job state between cases. */
export function __resetBugReportJobsForTests(): void {
  jobs.clear();
}
