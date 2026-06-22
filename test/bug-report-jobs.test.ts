import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startBugReportJob,
  getBugReportJob,
  __resetBugReportJobsForTests,
} from '../src/bug-report-jobs.js';

// Reuses the same fake-systemd-run-on-PATH strategy as bug-report.test.ts:
// the job registry drives the real generateBugReport, so we stand up a
// fake host collector and assert the job transitions running → done/error.

interface Sandbox {
  pathDir: string;
  hostBinDir: string;
  bugReportDir: string;
  mountinfoPath: string;
  origPath: string | undefined;
  origHostBin: string | undefined;
  origBugReportDir: string | undefined;
  origMountinfo: string | undefined;
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function writeFakeMountinfo(sb: Sandbox): Promise<void> {
  const lines = [
    `1 0 8:1 ${sb.hostBinDir} ${sb.hostBinDir} rw - tmpfs tmpfs rw`,
    `2 0 8:1 ${sb.bugReportDir} ${sb.bugReportDir} rw - tmpfs tmpfs rw`,
  ];
  await writeFile(sb.mountinfoPath, lines.join('\n') + '\n');
}

/** Poll the job until it leaves 'running' or we hit a wall-clock cap.
 *  Mirrors what the webapp's poll loop does, minus the HTTP hop. */
async function waitForJob(jobId: string, capMs = 5000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    const job = getBugReportJob(jobId);
    if (job && job.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not leave running within cap');
}

describe('bug-report job registry', () => {
  let root: string;
  let sb: Sandbox;

  beforeEach(async () => {
    __resetBugReportJobsForTests();
    root = await mkdtemp(join(tmpdir(), 'doctor-bug-job-test-'));
    sb = {
      pathDir: join(root, 'path'),
      hostBinDir: join(root, 'host-bin'),
      bugReportDir: join(root, 'bug-reports'),
      mountinfoPath: join(root, 'mountinfo'),
      origPath: process.env.PATH,
      origHostBin: process.env.HOST_BIN_DIR,
      origBugReportDir: process.env.BUG_REPORT_DIR,
      origMountinfo: process.env.BUG_REPORT_MOUNTINFO_PATH,
    };
    await mkdir(sb.pathDir, { recursive: true });
    await mkdir(sb.hostBinDir, { recursive: true });
    await writeExecutable(join(sb.hostBinDir, 'signalk'), '#!/usr/bin/env bash\necho host\n');
    await writeFakeMountinfo(sb);
    process.env.PATH = `${sb.pathDir}:${sb.origPath ?? ''}`;
    process.env.HOST_BIN_DIR = sb.hostBinDir;
    process.env.BUG_REPORT_DIR = sb.bugReportDir;
    process.env.BUG_REPORT_MOUNTINFO_PATH = sb.mountinfoPath;
  });

  afterEach(async () => {
    __resetBugReportJobsForTests();
    process.env.PATH = sb.origPath;
    if (sb.origHostBin === undefined) delete process.env.HOST_BIN_DIR;
    else process.env.HOST_BIN_DIR = sb.origHostBin;
    if (sb.origBugReportDir === undefined) delete process.env.BUG_REPORT_DIR;
    else process.env.BUG_REPORT_DIR = sb.origBugReportDir;
    if (sb.origMountinfo === undefined) delete process.env.BUG_REPORT_MOUNTINFO_PATH;
    else process.env.BUG_REPORT_MOUNTINFO_PATH = sb.origMountinfo;
    await rm(root, { recursive: true, force: true });
  });

  it('returns a jobId immediately and transitions running → done', async () => {
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      '#!/usr/bin/env bash\n' +
        `echo 'fake tarball' > '${sb.bugReportDir}/signalk-bug-report-20260601T000000Z.tar.gz'\n` +
        'exit 0\n',
    );
    const started = startBugReportJob();
    expect(started.status).toBe('running');
    expect(started.jobId).toMatch(/[0-9a-f-]{36}/);
    expect(started.reused).toBe(false);
    // The POST returns before the collector finishes.
    expect(getBugReportJob(started.jobId)?.status).toBe('running');

    await waitForJob(started.jobId);
    const job = getBugReportJob(started.jobId);
    expect(job?.status).toBe('done');
    if (job?.status === 'done') {
      expect(job.result.filename).toBe('signalk-bug-report-20260601T000000Z.tar.gz');
      expect(job.result.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('transitions running → error and carries the categorized reason', async () => {
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "boom" >&2\nexit 7\n',
    );
    const started = startBugReportJob();
    await waitForJob(started.jobId);
    const job = getBugReportJob(started.jobId);
    expect(job?.status).toBe('error');
    if (job?.status === 'error') {
      expect(job.result.reason).toBe('nonzero-exit');
      expect(job.result.exitCode).toBe(7);
    }
  });

  it('reuses an in-flight job instead of spawning a second collector', async () => {
    // A slow fake so the first job is still running when we start again.
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      '#!/usr/bin/env bash\nsleep 0.5\n' +
        `echo x > '${sb.bugReportDir}/signalk-bug-report-20260601T010000Z.tar.gz'\nexit 0\n`,
    );
    const first = startBugReportJob();
    const second = startBugReportJob();
    expect(second.jobId).toBe(first.jobId);
    expect(second.reused).toBe(true);
    await waitForJob(first.jobId);
    expect(getBugReportJob(first.jobId)?.status).toBe('done');
  });

  it('returns undefined for an unknown jobId', () => {
    expect(getBugReportJob('does-not-exist')).toBeUndefined();
  });
});
