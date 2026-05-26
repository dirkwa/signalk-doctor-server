import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { requireToken } from '../auth.js';
import { generateBugReport } from '../bug-report.js';

export async function registerBugReportRoutes(app: FastifyInstance): Promise<void> {
  // POST because the side effects are real: spawns a host process,
  // writes a multi-MB tarball under ~/.signalk-doctor/bug-reports/,
  // can take minutes. Bearer-gated like the other mutating routes
  // (recover, installer/refresh).
  //
  // Returns the tarball binary as the response body so a browser can
  // download it directly. The host script's stdout is captured server-
  // side; only the structured metadata (filename, size, durationMs)
  // surfaces via response headers for the webapp to display.
  app.post('/api/bug-report', { preHandler: requireToken }, async (_req, reply) => {
    const result = await generateBugReport(app.log);
    if (!result.ok) {
      reply.code(result.reason === 'host-bin-missing' ? 503 : 500);
      return {
        error: result.detail,
        reason: result.reason,
        ...(result.stderr ? { stderr: result.stderr } : {}),
        ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
        durationMs: result.durationMs,
      };
    }
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename="${result.filename}"`);
    reply.header('content-length', String(result.sizeBytes));
    // Custom headers so the webapp can show "took 47s, 3.2 MB" without
    // parsing the binary body or making a second request.
    reply.header('x-bug-report-duration-ms', String(result.durationMs));
    reply.header('x-bug-report-filename', result.filename);
    return reply.send(createReadStream(result.path));
  });
}
