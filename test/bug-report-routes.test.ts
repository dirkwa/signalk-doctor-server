import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { __resetBugReportJobsForTests } from '../src/bug-report-jobs.js';
import { __resetTokenCacheForTests } from '../src/auth.js';

// End-to-end of the three-route async flow over app.inject():
//   POST /api/bug-report (bearer)         → 202 { jobId }
//   GET  /api/bug-report/:jobId            → poll until done
//   GET  /api/bug-report/:jobId/download   → tarball bytes
// A fake systemd-run on PATH plays the host collector (same harness as
// bug-report.test.ts). A token file backs the bearer gate on POST.

const TOKEN = 'route-test-token';

interface Sandbox {
  root: string;
  pathDir: string;
  hostBinDir: string;
  bugReportDir: string;
  mountinfoPath: string;
  tokenPath: string;
  saved: Record<string, string | undefined>;
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function setup(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'doctor-bug-routes-'));
  const sb: Sandbox = {
    root,
    pathDir: join(root, 'path'),
    hostBinDir: join(root, 'host-bin'),
    bugReportDir: join(root, 'bug-reports'),
    mountinfoPath: join(root, 'mountinfo'),
    tokenPath: join(root, 'token'),
    saved: {
      PATH: process.env.PATH,
      HOST_BIN_DIR: process.env.HOST_BIN_DIR,
      BUG_REPORT_DIR: process.env.BUG_REPORT_DIR,
      BUG_REPORT_MOUNTINFO_PATH: process.env.BUG_REPORT_MOUNTINFO_PATH,
      TOKEN_PATH: process.env.TOKEN_PATH,
    },
  };
  await mkdir(sb.pathDir, { recursive: true });
  await mkdir(sb.hostBinDir, { recursive: true });
  await writeExecutable(join(sb.hostBinDir, 'signalk'), '#!/usr/bin/env bash\necho host\n');
  await writeFile(sb.tokenPath, `${TOKEN}\n`, 'utf8');
  await writeFile(
    sb.mountinfoPath,
    `1 0 8:1 ${sb.hostBinDir} ${sb.hostBinDir} rw - tmpfs tmpfs rw\n` +
      `2 0 8:1 ${sb.bugReportDir} ${sb.bugReportDir} rw - tmpfs tmpfs rw\n`,
  );
  process.env.PATH = `${sb.pathDir}:${sb.saved.PATH ?? ''}`;
  process.env.HOST_BIN_DIR = sb.hostBinDir;
  process.env.BUG_REPORT_DIR = sb.bugReportDir;
  process.env.BUG_REPORT_MOUNTINFO_PATH = sb.mountinfoPath;
  process.env.TOKEN_PATH = sb.tokenPath;
  __resetBugReportJobsForTests();
  __resetTokenCacheForTests();
  return sb;
}

async function teardown(sb: Sandbox): Promise<void> {
  for (const [k, v] of Object.entries(sb.saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetBugReportJobsForTests();
  __resetTokenCacheForTests();
  await rm(sb.root, { recursive: true, force: true });
}

async function pollUntilDone(
  app: Awaited<ReturnType<typeof createServer>>['app'],
  jobId: string,
  capMs = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: 'GET', url: `/api/bug-report/${jobId}` });
    const body = res.json() as Record<string, unknown>;
    if (body.status !== 'running') return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish within cap');
}

describe('bug-report routes (async flow)', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await setup();
  });
  afterEach(async () => {
    await teardown(sb);
  });

  it('POST returns 202 + jobId, GET polls to done, download streams the tarball', async () => {
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      '#!/usr/bin/env bash\n' +
        `echo 'fake tarball content' > '${sb.bugReportDir}/signalk-bug-report-20260601T000000Z.tar.gz'\n` +
        'exit 0\n',
    );
    const { app, driftScheduler } = await createServer();
    try {
      const post = await app.inject({
        method: 'POST',
        url: '/api/bug-report',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(post.statusCode).toBe(202);
      const started = post.json() as { jobId: string; status: string };
      expect(started.status).toBe('running');
      expect(started.jobId).toMatch(/[0-9a-f-]{36}/);

      const done = await pollUntilDone(app, started.jobId);
      expect(done.status).toBe('done');
      expect(done.filename).toBe('signalk-bug-report-20260601T000000Z.tar.gz');
      expect(typeof done.sizeBytes).toBe('number');
      // The host filesystem path must NOT leak to the client.
      expect(done).not.toHaveProperty('path');

      const dl = await app.inject({
        method: 'GET',
        url: `/api/bug-report/${started.jobId}/download`,
      });
      expect(dl.statusCode).toBe(200);
      expect(dl.headers['content-type']).toBe('application/gzip');
      expect(dl.headers['x-bug-report-filename']).toBe(
        'signalk-bug-report-20260601T000000Z.tar.gz',
      );
      expect(dl.rawPayload.length).toBeGreaterThan(0);
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });

  it('POST without a bearer is rejected 401 (CC-2)', async () => {
    const { app, driftScheduler } = await createServer();
    try {
      const post = await app.inject({ method: 'POST', url: '/api/bug-report' });
      expect(post.statusCode).toBe(401);
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });

  it('GET status for an unknown jobId is 404', async () => {
    const { app, driftScheduler } = await createServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/bug-report/nope' });
      expect(res.statusCode).toBe(404);
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });

  it('download while still running returns 409, not a truncated stream', async () => {
    // Slow collector so the job is still running when we hit download.
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      '#!/usr/bin/env bash\nsleep 0.6\n' +
        `echo x > '${sb.bugReportDir}/signalk-bug-report-20260601T020000Z.tar.gz'\nexit 0\n`,
    );
    const { app, driftScheduler } = await createServer();
    try {
      const post = await app.inject({
        method: 'POST',
        url: '/api/bug-report',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const started = post.json() as { jobId: string };
      const dl = await app.inject({
        method: 'GET',
        url: `/api/bug-report/${started.jobId}/download`,
      });
      expect(dl.statusCode).toBe(409);
      expect((dl.json() as { status: string }).status).toBe('running');
      // Let the job finish so teardown doesn't race the background spawn.
      await pollUntilDone(app, started.jobId);
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });

  it('download after a failed job returns 409 with status=error', async () => {
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "nope" >&2\nexit 1\n',
    );
    const { app, driftScheduler } = await createServer();
    try {
      const post = await app.inject({
        method: 'POST',
        url: '/api/bug-report',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const started = post.json() as { jobId: string };
      await pollUntilDone(app, started.jobId);
      const dl = await app.inject({
        method: 'GET',
        url: `/api/bug-report/${started.jobId}/download`,
      });
      expect(dl.statusCode).toBe(409);
      const body = dl.json() as { status: string; reason: string };
      expect(body.status).toBe('error');
      expect(body.reason).toBe('nonzero-exit');
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });

  it('surfaces a host-script failure as status=error with the reason', async () => {
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "kaboom" >&2\nexit 5\n',
    );
    const { app, driftScheduler } = await createServer();
    try {
      const post = await app.inject({
        method: 'POST',
        url: '/api/bug-report',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const started = post.json() as { jobId: string };
      const result = await pollUntilDone(app, started.jobId);
      expect(result.status).toBe('error');
      expect(result.reason).toBe('nonzero-exit');
      expect(result.exitCode).toBe(5);
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });
});
