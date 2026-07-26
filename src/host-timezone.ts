import { spawn } from 'node:child_process';

// Read the HOST's IANA timezone from inside the doctor container.
//
// Why systemd-run and not a file read: the doctor doesn't mount the host's
// time files, and mounting them is a dead end — /etc/timezone is absent on
// some supported hosts (mounting a missing source bricks the unit), and
// /etc/localtime is a symlink podman follows to a raw tzfile that can't be
// reverse-resolved to an IANA name reliably. timedate1 (the authoritative
// source) lives on the SYSTEM bus, which the doctor doesn't mount — only the
// user bus. So we ask the host's USER systemd manager to run `timedatectl`
// as a transient unit over the already-mounted /host/dbus; timedatectl talks
// to the system bus host-side and prints the live IANA name. Same
// systemd-run --user --pipe --wait mechanism src/bug-report.ts uses, but we
// need stdout here (the zone name) rather than a tarball on disk.
//
// timedatectl is a standard host binary; we defer its lookup to the host by
// wrapping in `/bin/sh -c` (same reason bug-report does — systemd-run
// pre-checks the executable in ITS OWN filesystem view before dispatching,
// and /bin/sh exists at the same path on both sides).

function timeoutMs(): number {
  const raw = process.env.HOST_TZ_TIMEOUT_MS;
  if (raw === undefined) return 5000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

export type HostTimezoneResult =
  | { ok: true; zone: string }
  | { ok: false; reason: 'timeout' | 'spawn-failed' | 'nonzero-exit' | 'empty'; detail: string };

interface SpawnOut {
  code: 'ok' | 'timeout' | 'spawn-failed';
  exitCode?: number;
  stdout: string;
  stderr: string;
  detail?: string;
}

function runSystemdRun(args: string[], ms: number): Promise<SpawnOut> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('systemd-run', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: 'timeout', stdout, stderr });
    }, ms);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
      if (stdout.length > 10_000) stdout = stdout.slice(stdout.length - 10_000);
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
      if (stderr.length > 10_000) stderr = stderr.slice(stderr.length - 10_000);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 'ok', exitCode: exitCode ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 'spawn-failed', detail: err.message, stdout, stderr });
    });
  });
}

// Validate the returned zone before trusting it. The lexical guard bounds
// the shape (a real IANA name, nothing exotic); the Intl check confirms it
// is an ACTUAL zone the platform knows — 'foo' and 'Not/AZone' pass the
// regex but throw RangeError here, so malformed host output degrades to
// 'unknown' instead of being treated as a trusted zone.
export function isValidZone(z: string): boolean {
  if (!/^[A-Za-z0-9_+/-]{1,64}$/.test(z)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

/** Read the host's live IANA timezone via `timedatectl show -p Timezone`
 *  run in the host user session. Returns a categorized failure rather than
 *  throwing so the probe can degrade to `unknown`. */
export async function readHostTimezone(): Promise<HostTimezoneResult> {
  // Bound the HOST-side transient unit itself with TimeoutStartSec, not only
  // our client-side timer: a Type=oneshot unit ignores RuntimeMaxSec, so
  // without this the host timedatectl could keep running after our timer
  // fires. Give the host unit the client budget and let our own timer sit a
  // beat longer so we still collect the unit's exit status in the normal case.
  const unitTimeoutSec = Math.max(1, Math.ceil(timeoutMs() / 1000));
  const args = [
    '--user',
    '--pipe',
    '--wait',
    '--collect',
    '--service-type=oneshot',
    '--quiet',
    `--property=TimeoutStartSec=${unitTimeoutSec}`,
    '--',
    '/bin/sh',
    '-c',
    'timedatectl show -p Timezone --value',
  ];
  const r = await runSystemdRun(args, timeoutMs() + 1000);
  if (r.code === 'timeout') {
    return {
      ok: false,
      reason: 'timeout',
      detail: `timedatectl did not finish within ${timeoutMs() + 1000}ms`,
    };
  }
  if (r.code === 'spawn-failed') {
    return { ok: false, reason: 'spawn-failed', detail: r.detail ?? 'systemd-run spawn failed' };
  }
  if (r.exitCode !== 0) {
    return {
      ok: false,
      reason: 'nonzero-exit',
      detail: `timedatectl exited ${r.exitCode}: ${r.stderr.trim() || '(no stderr)'}`,
    };
  }
  const zone = r.stdout.trim();
  if (!zone || !isValidZone(zone)) {
    return {
      ok: false,
      reason: 'empty',
      detail: `timedatectl returned no usable zone (${JSON.stringify(zone)})`,
    };
  }
  return { ok: true, zone };
}
