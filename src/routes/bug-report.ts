import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { requireToken } from '../auth.js';
import { startBugReportJob, getBugReportJob } from '../bug-report-jobs.js';

// Bug-report is a three-step async flow so the signalk-doctor plugin
// proxy's 15s header watchdog never fires (a synchronous collector
// routinely blocks past it on a cold boat → "HTTP 502" every time):
//
//   POST /api/bug-report             → 202 { jobId, status, startedAt }
//   GET  /api/bug-report/:jobId      → { status, ... } (poll until done)
//   GET  /api/bug-report/:jobId/download → streams the tarball
//
// The POST is bearer-gated (CC-2) like the other mutating routes — it
// spawns a host process and writes a multi-MB tarball. The two GETs are
// read-only and gated instead by the unguessable random jobId (a
// capability token), consistent with CC-2's "read-only routes are
// unauthenticated" and with the webapp's auth model (bearer on non-GET
// only). The same model the webapp already relies on for its filebin
// upload URL.
export async function registerBugReportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/bug-report', { preHandler: requireToken }, async (_req, reply) => {
    const started = startBugReportJob(app.log);
    reply.code(202);
    return {
      jobId: started.jobId,
      status: started.status,
      startedAt: started.startedAt,
      ...(started.reused ? { reused: true } : {}),
    };
  });

  app.get<{ Params: { jobId: string } }>('/api/bug-report/:jobId', async (req, reply) => {
    const job = getBugReportJob(req.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: 'no such bug-report job', status: 'unknown' };
    }
    if (job.status === 'running') {
      return { status: 'running', startedAt: job.startedAt };
    }
    if (job.status === 'done') {
      // Expose only client-safe metadata — NOT the host filesystem path.
      return {
        status: 'done',
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        filename: job.result.filename,
        sizeBytes: job.result.sizeBytes,
        durationMs: job.result.durationMs,
      };
    }
    // status === 'error'
    return {
      status: 'error',
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      reason: job.result.reason,
      detail: job.result.detail,
      ...(job.result.stderr ? { stderr: job.result.stderr } : {}),
      ...(typeof job.result.exitCode === 'number' ? { exitCode: job.result.exitCode } : {}),
      durationMs: job.result.durationMs,
    };
  });

  app.get<{ Params: { jobId: string } }>('/api/bug-report/:jobId/download', async (req, reply) => {
    const job = getBugReportJob(req.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: 'no such bug-report job' };
    }
    if (job.status === 'running') {
      // 409: the tarball isn't ready yet. The webapp polls the status
      // route and only hits download once status === 'done'; a direct
      // caller gets a clear "not ready" rather than a truncated stream.
      reply.code(409);
      return { error: 'bug-report still running', status: 'running' };
    }
    if (job.status === 'error') {
      reply.code(409);
      return { error: 'bug-report failed', status: 'error', reason: job.result.reason };
    }
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename="${job.result.filename}"`);
    reply.header('content-length', String(job.result.sizeBytes));
    reply.header('x-bug-report-duration-ms', String(job.result.durationMs));
    reply.header('x-bug-report-filename', job.result.filename);
    return reply.send(createReadStream(job.result.path));
  });
}
