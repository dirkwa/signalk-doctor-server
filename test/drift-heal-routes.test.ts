import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer } from '../src/server.js';
import { __resetTokenCacheForTests } from '../src/auth.js';
import { __resetHealJobsForTests, startHealJob, getHealJob } from '../src/drift/heal-jobs.js';
import { registerDriftRoutes, type ExplainRunner, type HealRunner } from '../src/routes/drift.js';
import type { DriftScheduler } from '../src/drift/scheduler.js';
import type { HealResult } from '../src/drift/heal.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pollJobUntilSettled(
  app: FastifyInstance,
  jobId: string,
): Promise<{ status: string; result?: HealResult }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const poll = await app.inject({ method: 'GET', url: `/api/drift/heal/${jobId}` });
    const body = poll.json() as { status: string; result?: HealResult };
    if (body.status !== 'running' || Date.now() > deadline) return body;
    await sleep(25);
  }
}

/** Bare app with just the drift routes and controllable runners — the seam
 *  for exercising the route contracts. */
async function bareApp(
  runner: HealRunner,
  explainRunner?: ExplainRunner,
): Promise<FastifyInstance> {
  const app = Fastify();
  const scheduler = { refreshNow: () => Promise.resolve() } as unknown as DriftScheduler;
  await registerDriftRoutes(app, scheduler, runner, explainRunner);
  return app;
}

function okResult(): HealResult {
  const now = new Date().toISOString();
  return {
    ok: true,
    startedAt: now,
    finishedAt: now,
    durationMs: 1,
    targets: [],
    exitCode: null,
    outputTail: '',
    packages: [],
  };
}

describe('drift heal routes', () => {
  let dir: string;
  const prevDoctorData = process.env.DOCTOR_DATA;
  const prevTokenPath = process.env.TOKEN_PATH;
  const prevLock = process.env.OPERATION_LOCK;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'drift-heal-routes-'));
    process.env.DOCTOR_DATA = dir;
    const tokenPath = join(dir, 'token');
    await writeFile(tokenPath, 'sekret\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(tokenPath, 0o600);
    process.env.TOKEN_PATH = tokenPath;
    // Point the shared operation lock into the temp dir so acquisition
    // works without the /updater-data mount.
    process.env.OPERATION_LOCK = join(dir, 'operation.lock');
    __resetTokenCacheForTests();
    __resetHealJobsForTests();
  });

  afterEach(async () => {
    if (prevDoctorData === undefined) delete process.env.DOCTOR_DATA;
    else process.env.DOCTOR_DATA = prevDoctorData;
    if (prevTokenPath === undefined) delete process.env.TOKEN_PATH;
    else process.env.TOKEN_PATH = prevTokenPath;
    if (prevLock === undefined) delete process.env.OPERATION_LOCK;
    else process.env.OPERATION_LOCK = prevLock;
    await rm(dir, { recursive: true, force: true });
  });

  it('POST /api/drift/heal requires bearer token', async () => {
    const { app, driftScheduler } = await createServer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/drift/heal' });
      expect(res.statusCode).toBe(401);
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });

  it('POST /api/drift/heal returns 409 while the shared operation lock is held', async () => {
    await writeFile(
      join(dir, 'operation.lock'),
      JSON.stringify({ owner: 'updater', operation: 'switch', startedAt: '2026-07-17T00:00:00Z' }),
    );
    const { app, driftScheduler } = await createServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/drift/heal',
        headers: { authorization: 'Bearer sekret' },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { lock: { owner: string; operation: string } };
      expect(body.lock.owner).toBe('updater');
      expect(body.lock.operation).toBe('switch');
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });

  it('POST starts a job (202) and the job settles as error when no drift report exists', async () => {
    const { app, driftScheduler } = await createServer();
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/api/drift/heal',
        headers: { authorization: 'Bearer sekret' },
      });
      expect(started.statusCode).toBe(202);
      const { jobId } = started.json() as { jobId: string };
      expect(jobId).toBeTruthy();

      const settled = await pollJobUntilSettled(app, jobId);
      expect(settled.status).toBe('error');
      expect(settled.result?.ok).toBe(false);
      if (settled.result && !settled.result.ok) expect(settled.result.reason).toBe('no-report');

      // The job released the mutex on completion: the lock file is gone,
      // so a second POST is not answered with 409.
      const again = await app.inject({
        method: 'POST',
        url: '/api/drift/heal',
        headers: { authorization: 'Bearer sekret' },
      });
      expect(again.statusCode).toBe(202);
      // Let the second job settle too — tearing down the app and temp dir
      // under a running job races its mutex/filesystem work.
      const { jobId: secondId } = again.json() as { jobId: string };
      await pollJobUntilSettled(app, secondId);
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });

  it('a duplicate POST while a heal runs reuses the job instead of 409ing on its own lock', async () => {
    let release: (r: HealResult) => void = () => {};
    const gate = new Promise<HealResult>((resolve) => {
      release = resolve;
    });
    const app = await bareApp(() => gate);
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/drift/heal',
        headers: { authorization: 'Bearer sekret' },
      });
      expect(first.statusCode).toBe(202);
      const firstBody = first.json() as { jobId: string };

      // The running job HOLDS the operation lock right now; the duplicate
      // POST must still come back 202 with the same job, not 409.
      const dup = await app.inject({
        method: 'POST',
        url: '/api/drift/heal',
        headers: { authorization: 'Bearer sekret' },
      });
      expect(dup.statusCode).toBe(202);
      const dupBody = dup.json() as { jobId: string; reused: boolean };
      expect(dupBody.reused).toBe(true);
      expect(dupBody.jobId).toBe(firstBody.jobId);

      release(okResult());
      await pollJobUntilSettled(app, firstBody.jobId);
      // Lock released on completion.
      await expect(access(join(dir, 'operation.lock'))).rejects.toThrow();
    } finally {
      await app.close();
    }
  });

  it('keeps the operation lock when the result says npm may still be running', async () => {
    const app = await bareApp(() => {
      const now = new Date().toISOString();
      return Promise.resolve({
        ok: false,
        reason: 'exec',
        detail: 'timeout: command did not finish',
        startedAt: now,
        finishedAt: now,
        durationMs: 1,
        lockRetained: true,
      });
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/drift/heal',
        headers: { authorization: 'Bearer sekret' },
      });
      expect(res.statusCode).toBe(202);
      const { jobId } = res.json() as { jobId: string };
      const settled = await pollJobUntilSettled(app, jobId);
      expect(settled.status).toBe('error');

      // CC-5: the lock file must still exist — npm was not proven stopped —
      // so the next POST bounces with 409 instead of racing it.
      await expect(access(join(dir, 'operation.lock'))).resolves.toBeUndefined();
      const next = await app.inject({
        method: 'POST',
        url: '/api/drift/heal',
        headers: { authorization: 'Bearer sekret' },
      });
      expect(next.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('POST /api/drift/explain requires token, validates body, passes names through', async () => {
    let received: string[] = [];
    const app = await bareApp(
      () => Promise.resolve(okResult()),
      (names) => {
        received = names;
        return Promise.resolve({
          ok: true,
          explanations: [
            {
              name: names[0] ?? '',
              version: '5.1.4',
              dependents: [{ name: 'signalk-some-plugin', version: '1.2.3', spec: '^5.0.0' }],
              extraneous: false,
              heldByEmbeddedServer: false,
            },
          ],
        });
      },
    );
    try {
      const noToken = await app.inject({
        method: 'POST',
        url: '/api/drift/explain',
        payload: { packages: ['@signalk/streams'] },
      });
      expect(noToken.statusCode).toBe(401);

      const badBody = await app.inject({
        method: 'POST',
        url: '/api/drift/explain',
        headers: { authorization: 'Bearer sekret' },
        payload: { packages: ['not a package name!'] },
      });
      expect(badBody.statusCode).toBe(400);

      const good = await app.inject({
        method: 'POST',
        url: '/api/drift/explain',
        headers: { authorization: 'Bearer sekret' },
        payload: { packages: ['@signalk/streams'] },
      });
      expect(good.statusCode).toBe(200);
      expect(received).toEqual(['@signalk/streams']);
      const body = good.json() as {
        explanations: Array<{ name: string; dependents: Array<{ name: string }> }>;
      };
      expect(body.explanations[0]?.dependents[0]?.name).toBe('signalk-some-plugin');
    } finally {
      await app.close();
    }
  });

  it('POST /api/drift/explain surfaces runner failure as 500 — never the proxy-reserved 502', async () => {
    const app = await bareApp(
      () => Promise.resolve(okResult()),
      () => Promise.resolve({ ok: false, detail: 'unreachable: no socket' }),
    );
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/drift/explain',
        headers: { authorization: 'Bearer sekret' },
        payload: { packages: ['@signalk/streams'] },
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: string }).error).toMatch(/no socket/);
    } finally {
      await app.close();
    }
  });

  it('GET /api/drift/heal/:jobId returns 404 for an unknown job', async () => {
    const { app, driftScheduler } = await createServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/drift/heal/nope' });
      expect(res.statusCode).toBe(404);
    } finally {
      driftScheduler.stop();
      await app.close();
    }
  });
});

describe('heal job registry', () => {
  beforeEach(() => __resetHealJobsForTests());

  it('settles as error when the runner throws synchronously', async () => {
    // A sync throw must land in the rejection arm, not escape startHealJob —
    // an escaped throw would leave the job 'running' forever and every
    // future start would reuse the corpse.
    const started = startHealJob(() => {
      throw new Error('sync boom');
    });
    await sleep(0);
    const job = getHealJob(started.jobId);
    expect(job?.status).toBe('error');
    if (job?.status !== 'error') return;
    expect(job.result.ok).toBe(false);
    if (!job.result.ok) expect(job.result.detail).toBe('sync boom');
  });

  it('reuses the running job instead of starting a second npm run', async () => {
    let release: (r: HealResult) => void = () => {};
    const gate = new Promise<HealResult>((resolve) => {
      release = resolve;
    });
    const first = startHealJob(() => gate);
    const second = startHealJob(() => {
      throw new Error('must not start a second run');
    });
    expect(second.reused).toBe(true);
    expect(second.jobId).toBe(first.jobId);

    release({
      ok: true,
      startedAt: first.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      targets: [],
      exitCode: null,
      outputTail: '',
      packages: [],
    });
    await sleep(0);
    const job = getHealJob(first.jobId);
    expect(job?.status).toBe('done');

    const third = startHealJob(() => gate);
    expect(third.reused).toBe(false);
    expect(third.jobId).not.toBe(first.jobId);
  });
});
