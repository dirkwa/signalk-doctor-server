import { spawn } from 'node:child_process';
import { readdir, stat, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// The host-side script the doctor delegates to. Bind-mounted into the
// container at /host-bin/signalk by the installer (see signalk-universal-
// installer Quadlet template). When the mount is missing — older install
// that predates the host-bin bind — we report it cleanly rather than
// blowing up at exec time.
function hostBinDir(): string {
  return process.env.HOST_BIN_DIR ?? '/host-bin';
}

// Where the host's `signalk bug-report --to <dir>` writes the tarball.
// On the host this is ~/.signalk-doctor/bug-reports/; inside the doctor
// container the same path is at /data/bug-reports/ via the existing
// ~/.signalk-doctor → /data Quadlet mount. No new mount needed.
function bugReportDir(): string {
  return process.env.BUG_REPORT_DIR ?? '/data/bug-reports';
}

// How long systemd-run is allowed to take. The bash bug-report walks
// 24h of journal output, inspects every signalk-* container, and tars
// the lot — slow on a busy boat. 10 minutes is the upper bound before
// we kill the unit and surface a timeout. Env-override exists so tests
// can shrink it to milliseconds without sleeping the test runner.
function bugReportTimeoutMs(): number {
  const raw = process.env.BUG_REPORT_TIMEOUT_MS;
  if (raw === undefined) return 10 * 60 * 1000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000;
}

// Keep this many tarballs around for offline retrieval (`ssh` then `ls
// ~/.signalk-doctor/bug-reports/`). Older ones are pruned at the start
// of each new run so the cap is enforced even if a previous run was
// killed before it could prune.
const RETENTION = 5;

export type BugReportResult =
  | { ok: true; path: string; filename: string; sizeBytes: number; durationMs: number }
  | {
      ok: false;
      reason:
        | 'host-bin-missing'
        | 'host-script-missing'
        | 'spawn-failed'
        | 'timeout'
        | 'nonzero-exit'
        | 'no-output'
        | 'unsupported-flag';
      detail: string;
      stderr?: string;
      exitCode?: number;
      durationMs: number;
    };

interface SpawnLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/** Run `signalk bug-report --to <dir>` on the host via systemd-run --user
 *  --pipe --wait, locate the resulting tarball under `<dir>`, and return
 *  its path. Captures stdout/stderr for diagnostics, surfaces a
 *  categorized error on any failure (host-bin not mounted, script
 *  missing, non-zero exit, timeout, etc.).
 *
 *  The host script is the one that knows how to gather host journals,
 *  systemd state, and signalk-server config; reusing it (rather than
 *  re-implementing in TS) means the doctor and the SSH'd-in operator
 *  produce byte-for-byte equivalent bundles.
 *
 *  The doctor delegates via systemd-run so the script runs in the
 *  host user's session (with the right $HOME, $XDG_RUNTIME_DIR, podman
 *  socket, etc.). Calling /host-bin/signalk directly from inside the
 *  doctor container would pick up the container's environment instead.
 *
 *  NOT gated on the CC-5 operation lock. The host `signalk bug-report`
 *  is read-mostly — it lists systemd units, inspects containers, dumps
 *  journals, redacts and copies settings.json. No Quadlet rewrites, no
 *  unit start/stop, no image pulls. Its only writes are under the
 *  per-invocation tarball-output directory, which the doctor owns and
 *  every operator-facing call would target. Holding the lock would
 *  also defeat the most important use case: running bug-report
 *  precisely BECAUSE the updater is wedged and the lock is stuck. */
export async function generateBugReport(log?: SpawnLogger): Promise<BugReportResult> {
  const start = Date.now();
  const hb = hostBinDir();
  const outDir = bugReportDir();
  const hostScript = `${hb}/signalk`;

  // Pre-flight: the /host-bin mount must exist and the signalk script
  // must be there. Without these, systemd-run would exec-fail in a way
  // the operator can't tell apart from a script crash.
  try {
    await stat(hb);
  } catch {
    return {
      ok: false,
      reason: 'host-bin-missing',
      detail: `${hb} is not mounted; rerun the bash installer to add the host-bin bind mount, then retry.`,
      durationMs: Date.now() - start,
    };
  }
  try {
    await stat(hostScript);
  } catch {
    return {
      ok: false,
      reason: 'host-script-missing',
      detail: `${hostScript} not found. Run \`signalk update\` (or POST /api/installer/refresh) to install the host script, then retry.`,
      durationMs: Date.now() - start,
    };
  }

  await mkdir(outDir, { recursive: true });
  // Prune older tarballs before the new run starts. Doing it up front
  // (rather than after a successful run) means the cap is enforced even
  // when the new run fails — otherwise a long string of failed reports
  // could pile up.
  await pruneOldReports(outDir, RETENTION - 1, log);

  const before = await listTarballs(outDir);
  const beforeSet = new Set(before);

  // Run via the host's user manager. --pipe + --wait gets stdout/stderr
  // back synchronously; --collect lets systemd garbage-collect the
  // transient unit after it exits even if we're slow to read its state.
  // --service-type=oneshot is the correct unit type for a "run to
  // completion" command. -G (no isolation from the calling tty) lets
  // the script's interactive prompts (which are skipped in non-tty mode
  // anyway) not interfere.
  const args = [
    '--user',
    '--pipe',
    '--wait',
    '--collect',
    '--service-type=oneshot',
    '--quiet',
    '--',
    hostScript,
    'bug-report',
    '--to',
    outDir,
  ];

  // DBUS_SESSION_BUS_ADDRESS is set by the Quadlet (Environment=...).
  // systemd-run picks the bus to talk to from there. No extra env
  // plumbing required on the spawn() call.
  const timeoutMs = bugReportTimeoutMs();
  const stderr = await runSystemdRun(args, timeoutMs, log);
  if (stderr.code === 'timeout') {
    return {
      ok: false,
      reason: 'timeout',
      detail: `bug-report did not finish within ${timeoutMs}ms`,
      stderr: stderr.stderr,
      durationMs: Date.now() - start,
    };
  }
  if (stderr.code === 'spawn-failed') {
    return {
      ok: false,
      reason: 'spawn-failed',
      detail: stderr.detail,
      stderr: stderr.stderr,
      durationMs: Date.now() - start,
    };
  }
  if (stderr.exitCode !== 0) {
    // Older host scripts don't support --to and bail with our own
    // [ERR] line. Surface that specifically so the webapp can tell
    // the operator to refresh the host script.
    if (/Unknown bug-report argument: --to/.test(stderr.stderr)) {
      return {
        ok: false,
        reason: 'unsupported-flag',
        detail:
          'host signalk script is too old to support `bug-report --to`. Run `signalk update` (or POST /api/installer/refresh) to refresh it, then retry.',
        stderr: stderr.stderr,
        exitCode: stderr.exitCode,
        durationMs: Date.now() - start,
      };
    }
    return {
      ok: false,
      reason: 'nonzero-exit',
      detail: `signalk bug-report exited ${stderr.exitCode}`,
      stderr: stderr.stderr,
      exitCode: stderr.exitCode,
      durationMs: Date.now() - start,
    };
  }

  // The script printed [OK] but check for the actual file. Pick the
  // newest tarball that wasn't there before the run — robust against
  // clock skew between the host and the container. `after` is sorted
  // lexicographically and our ISO-Z timestamps are ordered the same
  // way chronologically, so the last element among the new entries is
  // the newest. If a prior run was killed mid-write (no error path
  // back, only the doctor-side run knows the new file wasn't ours),
  // `find()` would have returned the stale orphan instead of our
  // freshly-produced tarball.
  const after = await listTarballs(outDir);
  const freshCandidates = after.filter((f) => !beforeSet.has(f));
  const fresh = freshCandidates.at(-1);
  if (!fresh) {
    return {
      ok: false,
      reason: 'no-output',
      detail: `no new tarball appeared in ${outDir} after a successful run`,
      stderr: stderr.stderr,
      durationMs: Date.now() - start,
    };
  }
  const fullPath = join(outDir, fresh);
  const stats = await stat(fullPath);
  return {
    ok: true,
    path: fullPath,
    filename: fresh,
    sizeBytes: stats.size,
    durationMs: Date.now() - start,
  };
}

async function listTarballs(dir: string): Promise<string[]> {
  try {
    const all = await readdir(dir);
    return all.filter((f) => f.startsWith('signalk-bug-report-') && f.endsWith('.tar.gz')).sort();
  } catch {
    return [];
  }
}

async function pruneOldReports(dir: string, keep: number, log?: SpawnLogger): Promise<void> {
  const tarballs = await listTarballs(dir);
  if (tarballs.length <= keep) return;
  // Oldest first (lexicographic == chronological for our ISO-Z stamps).
  const toRemove = tarballs.slice(0, tarballs.length - keep);
  for (const name of toRemove) {
    const p = join(dir, name);
    try {
      await unlink(p);
    } catch (err) {
      log?.warn(
        { err: err instanceof Error ? err.message : String(err), path: p },
        'bug-report: prune failed',
      );
    }
  }
}

type SpawnOutcome =
  | { code: 'ok'; exitCode: number; stderr: string }
  | { code: 'timeout'; stderr: string }
  | { code: 'spawn-failed'; detail: string; stderr: string };

function runSystemdRun(
  args: string[],
  timeoutMs: number,
  log?: SpawnLogger,
): Promise<SpawnOutcome & { exitCode?: number }> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const child = spawn('systemd-run', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: 'timeout', stderr });
    }, timeoutMs);
    // We don't need stdout — the host script writes its result to the
    // tarball dir and we locate it afterwards. Draining stdout still
    // prevents the pipe from backpressuring.
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
      // Cap captured stderr so a runaway script can't OOM the doctor.
      if (stderr.length > 100_000) stderr = stderr.slice(stderr.length - 100_000);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 'ok', exitCode: exitCode ?? -1, stderr });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log?.warn({ err: err.message }, 'bug-report: spawn failed');
      resolve({ code: 'spawn-failed', detail: err.message, stderr });
    });
  });
}
