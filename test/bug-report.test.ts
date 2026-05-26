import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBugReport } from '../src/bug-report.js';

// Strategy: stand up a fake `systemd-run` on PATH that the engine
// invokes instead of the real one. The fake script writes whatever
// arguments and behavior we want for the case under test (success,
// non-zero exit, "old script" stderr, etc.) and creates the tarball
// the engine then locates. That exercises the full flow — directory
// scan, fresh-file detection, retention pruning — without needing
// systemd or a host.

interface Sandbox {
  pathDir: string;
  hostBinDir: string;
  bugReportDir: string;
  origPath: string | undefined;
  origHostBin: string | undefined;
  origBugReportDir: string | undefined;
}

async function activateSandbox(sb: Sandbox): Promise<void> {
  process.env.PATH = `${sb.pathDir}:${sb.origPath ?? ''}`;
  process.env.HOST_BIN_DIR = sb.hostBinDir;
  process.env.BUG_REPORT_DIR = sb.bugReportDir;
}

async function teardown(sb: Sandbox, root: string): Promise<void> {
  process.env.PATH = sb.origPath;
  if (sb.origHostBin === undefined) delete process.env.HOST_BIN_DIR;
  else process.env.HOST_BIN_DIR = sb.origHostBin;
  if (sb.origBugReportDir === undefined) delete process.env.BUG_REPORT_DIR;
  else process.env.BUG_REPORT_DIR = sb.origBugReportDir;
  await rm(root, { recursive: true, force: true });
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

/** Fake systemd-run that:
 *  - exits with `exitCode`
 *  - writes `stderr` to stderr
 *  - if `tarballName` is set, creates a tarball-shaped file at
 *    `<bugReportDir>/<tarballName>` BEFORE exiting (simulating
 *    a successful host script).
 *
 *  The arguments the engine passes are not parsed — we only care
 *  about the systemd-run binary being invokable from PATH. */
function fakeSystemdRun(opts: {
  exitCode: number;
  stderr?: string;
  tarballName?: string;
  bugReportDir: string;
}): string {
  const lines = ['#!/usr/bin/env bash'];
  if (opts.stderr) {
    const esc = opts.stderr.replace(/'/g, "'\\''");
    lines.push(`printf '%s\\n' '${esc}' >&2`);
  }
  if (opts.tarballName) {
    const tarballPath = `${opts.bugReportDir}/${opts.tarballName}`;
    lines.push(`mkdir -p '${opts.bugReportDir}'`);
    lines.push(`echo 'fake tarball content' > '${tarballPath}'`);
  }
  lines.push(`exit ${opts.exitCode}`);
  return lines.join('\n') + '\n';
}

describe('generateBugReport', () => {
  let root: string;
  let sb: Sandbox;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'doctor-bug-report-test-'));
    sb = {
      pathDir: join(root, 'path'),
      hostBinDir: join(root, 'host-bin'),
      bugReportDir: join(root, 'bug-reports'),
      origPath: process.env.PATH,
      origHostBin: process.env.HOST_BIN_DIR,
      origBugReportDir: process.env.BUG_REPORT_DIR,
    };
    // Don't pre-create hostBinDir here — some tests want it missing.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sb.pathDir, { recursive: true });
    await activateSandbox(sb);
  });

  afterEach(async () => {
    await teardown(sb, root);
  });

  it('reports host-bin-missing when /host-bin mount is absent', async () => {
    const r = await generateBugReport();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('host-bin-missing');
    expect(r.detail).toMatch(/not mounted/);
  });

  it('reports host-script-missing when /host-bin exists but signalk is not in it', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sb.hostBinDir, { recursive: true });
    const r = await generateBugReport();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('host-script-missing');
    expect(r.detail).toMatch(/Run `signalk update`/);
  });

  it('returns ok with the freshly-created tarball when systemd-run succeeds', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sb.hostBinDir, { recursive: true });
    await writeExecutable(join(sb.hostBinDir, 'signalk'), '#!/usr/bin/env bash\necho host\n');
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      fakeSystemdRun({
        exitCode: 0,
        tarballName: 'signalk-bug-report-20260526T010000Z.tar.gz',
        bugReportDir: sb.bugReportDir,
      }),
    );
    const r = await generateBugReport();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filename).toBe('signalk-bug-report-20260526T010000Z.tar.gz');
    expect(r.sizeBytes).toBeGreaterThan(0);
    expect(r.path).toBe(join(sb.bugReportDir, r.filename));
    const fileStat = await stat(r.path);
    expect(fileStat.isFile()).toBe(true);
  });

  it('reports unsupported-flag when host script bails on --to', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sb.hostBinDir, { recursive: true });
    await writeExecutable(join(sb.hostBinDir, 'signalk'), '#!/usr/bin/env bash\necho host\n');
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      fakeSystemdRun({
        exitCode: 1,
        stderr: '[ERR] Unknown bug-report argument: --to',
        bugReportDir: sb.bugReportDir,
      }),
    );
    const r = await generateBugReport();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unsupported-flag');
    expect(r.detail).toMatch(/host signalk script is too old/);
  });

  it('reports nonzero-exit for generic host-script failures', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sb.hostBinDir, { recursive: true });
    await writeExecutable(join(sb.hostBinDir, 'signalk'), '#!/usr/bin/env bash\necho host\n');
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      fakeSystemdRun({
        exitCode: 7,
        stderr: 'something else broke',
        bugReportDir: sb.bugReportDir,
      }),
    );
    const r = await generateBugReport();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('nonzero-exit');
    expect(r.exitCode).toBe(7);
    expect(r.stderr).toContain('something else broke');
  });

  it('reports no-output when systemd-run succeeds but no tarball appears', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sb.hostBinDir, { recursive: true });
    await writeExecutable(join(sb.hostBinDir, 'signalk'), '#!/usr/bin/env bash\necho host\n');
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      fakeSystemdRun({ exitCode: 0, bugReportDir: sb.bugReportDir }),
    );
    const r = await generateBugReport();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-output');
  });

  it('prunes old tarballs to RETENTION-1 before a new run', async () => {
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    await mkdir(sb.hostBinDir, { recursive: true });
    await mkdir(sb.bugReportDir, { recursive: true });
    await writeExecutable(join(sb.hostBinDir, 'signalk'), '#!/usr/bin/env bash\necho host\n');
    // Seed 10 pre-existing tarballs; the engine should keep only the
    // last 4 (RETENTION-1 = 5-1) before adding the new one == 5 total.
    for (let i = 0; i < 10; i++) {
      const stamp = `2026010${i}T000000Z`;
      await wf(join(sb.bugReportDir, `signalk-bug-report-${stamp}.tar.gz`), `old ${i}`);
    }
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      fakeSystemdRun({
        exitCode: 0,
        tarballName: 'signalk-bug-report-20260526T020000Z.tar.gz',
        bugReportDir: sb.bugReportDir,
      }),
    );
    const r = await generateBugReport();
    expect(r.ok).toBe(true);
    const remaining = (await readdir(sb.bugReportDir))
      .filter((f) => f.startsWith('signalk-bug-report-') && f.endsWith('.tar.gz'))
      .sort();
    // 5 total: 4 oldest survivors + the new one.
    expect(remaining.length).toBe(5);
    expect(remaining.includes('signalk-bug-report-20260526T020000Z.tar.gz')).toBe(true);
    // The oldest 6 should be gone; survivors are 20260106-20260109.
    expect(remaining).toEqual([
      'signalk-bug-report-20260106T000000Z.tar.gz',
      'signalk-bug-report-20260107T000000Z.tar.gz',
      'signalk-bug-report-20260108T000000Z.tar.gz',
      'signalk-bug-report-20260109T000000Z.tar.gz',
      'signalk-bug-report-20260526T020000Z.tar.gz',
    ]);
  });

  it('reports spawn-failed when systemd-run is not on PATH', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sb.hostBinDir, { recursive: true });
    await writeExecutable(join(sb.hostBinDir, 'signalk'), '#!/usr/bin/env bash\necho host\n');
    // Truncate PATH to ONLY the empty sandbox dir — otherwise /usr/bin's
    // real systemd-run would be picked up and the test would never
    // exercise the ENOENT path. activateSandbox appended the original
    // PATH; restore it after via the existing teardown().
    process.env.PATH = sb.pathDir;
    const r = await generateBugReport();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('spawn-failed');
    expect(r.detail).toMatch(/ENOENT|not found|systemd-run/i);
  });

  it('reports timeout when systemd-run does not finish in BUG_REPORT_TIMEOUT_MS', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sb.hostBinDir, { recursive: true });
    await writeExecutable(join(sb.hostBinDir, 'signalk'), '#!/usr/bin/env bash\necho host\n');
    // Fake systemd-run that sleeps longer than the test timeout. The
    // 200ms ceiling we set via env makes the test fast; in production
    // the default is 10 minutes.
    await writeExecutable(
      join(sb.pathDir, 'systemd-run'),
      '#!/usr/bin/env bash\nsleep 5\nexit 0\n',
    );
    const prev = process.env.BUG_REPORT_TIMEOUT_MS;
    process.env.BUG_REPORT_TIMEOUT_MS = '200';
    try {
      const r = await generateBugReport();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('timeout');
      expect(r.detail).toMatch(/did not finish within 200ms/);
    } finally {
      if (prev === undefined) delete process.env.BUG_REPORT_TIMEOUT_MS;
      else process.env.BUG_REPORT_TIMEOUT_MS = prev;
    }
  });
});
