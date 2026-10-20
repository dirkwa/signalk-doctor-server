import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Records the host boot the doctor runs in, so the host-restarts probe can tell
// whether the previous boot ended with a shutdown. When systemd stops the user
// units during a shutdown, podman sends the doctor SIGTERM and the doctor marks
// its record `cleanStop`. A start under a new boot ID whose previous record is
// not marked means the host went down without stopping the doctor: a watchdog
// reset, a power cut or a kernel panic. A doctor restart within one boot keeps
// the boot ID, so it is never counted.

export interface UncleanRestart {
  /** boot_id of the boot that ended without a clean stop. */
  bootId: string;
  /** When the doctor started during that boot. */
  doctorStartedAt: string;
  /** When the host came back up, from /proc/stat btime. */
  hostBootedAt: string | null;
  detectedAt: string;
  /** When the doctor first saw the Pi's under-voltage alarm during that boot. */
  underVoltageAt: string | null;
}

export interface HostBootState {
  version: 1;
  bootId: string;
  startedAt: string;
  cleanStop: boolean;
  trackingSince: string;
  unclean: UncleanRestart[];
  /** When the doctor first saw the Pi's under-voltage alarm during this boot
   *  (sampled by src/pi-power.ts). */
  underVoltageAt: string | null;
}

const MAX_UNCLEAN = 20;

// Read per call so tests can point them at fixtures.
function doctorData(): string {
  return process.env.DOCTOR_DATA ?? '/data';
}
function procRoot(): string {
  return process.env.HOST_PROC ?? '/proc';
}
export function hostBootsPath(): string {
  return join(doctorData(), 'host-boots.json');
}

let current: HostBootState | null = null;

/** The host's boot ID. /proc/sys/kernel/random/boot_id is not namespaced, so a
 *  rootless container reads the host's value. */
export async function readBootId(): Promise<string | null> {
  try {
    const id = (await readFile(join(procRoot(), 'sys/kernel/random/boot_id'), 'utf8')).trim();
    return /^[0-9a-f-]{36}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function readHostBootedAt(): Promise<string | null> {
  try {
    const stat = await readFile(join(procRoot(), 'stat'), 'utf8');
    const btime = /^btime (\d+)$/m.exec(stat)?.[1];
    return btime ? new Date(Number(btime) * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/** WSL2 kernels carry "microsoft" in their release string. Windows stops the
 *  Podman machine without shutting it down, so every Windows restart would
 *  read as unclean there. */
export async function isWsl(): Promise<boolean> {
  try {
    return /microsoft/i.test(await readFile(join(procRoot(), 'sys/kernel/osrelease'), 'utf8'));
  } catch {
    return false;
  }
}

// Records written before underVoltageAt existed lack the field; it reads as null.
function isOptionalTime(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isUncleanRestart(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.bootId === 'string' &&
    typeof v.doctorStartedAt === 'string' &&
    (typeof v.hostBootedAt === 'string' || v.hostBootedAt === null) &&
    typeof v.detectedAt === 'string' &&
    isOptionalTime(v.underVoltageAt)
  );
}

/** The stored record, or null when it is missing or not in the expected shape. */
export async function loadHostBoots(): Promise<HostBootState | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(hostBootsPath(), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const s = parsed as Record<string, unknown>;
  if (
    s.version !== 1 ||
    typeof s.bootId !== 'string' ||
    typeof s.startedAt !== 'string' ||
    typeof s.cleanStop !== 'boolean' ||
    typeof s.trackingSince !== 'string' ||
    !Array.isArray(s.unclean) ||
    !s.unclean.every(isUncleanRestart) ||
    !isOptionalTime(s.underVoltageAt)
  ) {
    return null;
  }
  const state = parsed as HostBootState;
  return {
    ...state,
    underVoltageAt: state.underVoltageAt ?? null,
    unclean: state.unclean.map((e) => ({ ...e, underVoltageAt: e.underVoltageAt ?? null })),
  };
}

// Synchronous so the SIGTERM handler can finish the write before it re-raises
// the signal.
function writeAtomicSync(filePath: string, body: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  const dirFd = openSync(dirname(filePath), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Called once at startup: compares the stored record with the current boot,
 *  appends an UncleanRestart when the previous boot ended without a clean stop,
 *  and stores a fresh record for this boot. Returns null without writing when
 *  the boot ID is unreadable or the host is WSL. */
export async function recordBoot(now = new Date()): Promise<HostBootState | null> {
  if (await isWsl()) return null;
  const bootId = await readBootId();
  if (!bootId) return null;
  const prev = await loadHostBoots();
  const unclean = prev ? [...prev.unclean] : [];
  if (prev && prev.bootId !== bootId && !prev.cleanStop) {
    unclean.push({
      bootId: prev.bootId,
      doctorStartedAt: prev.startedAt,
      hostBootedAt: await readHostBootedAt(),
      detectedAt: now.toISOString(),
      underVoltageAt: prev.underVoltageAt,
    });
  }
  const next: HostBootState = {
    version: 1,
    bootId,
    startedAt: now.toISOString(),
    cleanStop: false,
    trackingSince: prev?.trackingSince ?? now.toISOString(),
    unclean: unclean.slice(-MAX_UNCLEAN),
    // A doctor restart within the same boot keeps what it already saw.
    underVoltageAt: prev?.bootId === bootId ? prev.underVoltageAt : null,
  };
  writeAtomicSync(hostBootsPath(), JSON.stringify(next, null, 2) + '\n');
  current = next;
  return next;
}

/** Stores the first under-voltage observation of this boot. Returns false
 *  when there is no record for this boot or it already holds one. */
export function noteUnderVoltage(now = new Date()): boolean {
  if (!current || current.underVoltageAt !== null) return false;
  const next = { ...current, underVoltageAt: now.toISOString() };
  writeAtomicSync(hostBootsPath(), JSON.stringify(next, null, 2) + '\n');
  current = next;
  return true;
}

/** Marks this boot's record as cleanly stopped. Never throws: it runs inside a
 *  signal handler, and a failed write only means the next start counts this
 *  boot as unclean. */
export function markCleanStopSync(): void {
  if (!current) return;
  try {
    writeAtomicSync(
      hostBootsPath(),
      JSON.stringify({ ...current, cleanStop: true }, null, 2) + '\n',
    );
  } catch {
    // The process is exiting; there is nobody left to report to.
  }
}

type SignalTarget = Pick<typeof process, 'once' | 'kill' | 'pid'>;

/** On SIGTERM or SIGINT: mark the clean stop, then re-raise the signal. `once`
 *  has removed the listener by then, so the re-raised signal gets Node's
 *  default action and the process exits by signal, as it did before this
 *  handler existed. */
export function installCleanStopHandlers(proc: SignalTarget = process): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    proc.once(signal, () => {
      markCleanStopSync();
      proc.kill(proc.pid, signal);
    });
  }
}

/** Test hook: forget the in-memory record. */
export function resetHostBootsForTest(): void {
  current = null;
}
