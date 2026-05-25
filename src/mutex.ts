import { open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export type Operation =
  | 'switch'
  | 'rollback'
  | 'self-update'
  | 'hardware-apply'
  | 'recover'
  | 'installer-refresh';

export interface LockInfo {
  owner: 'updater' | 'doctor';
  operation: Operation;
  startedAt: string;
  pid?: number;
}

// The lock lives under the updater's data directory; the doctor mounts that
// directory as /updater-data (rw) so both engines can write to the shared
// lock. Resolved lazily so tests can swap LOCK_DIR / OPERATION_LOCK between
// cases; in production the env vars are set once by the systemd-user unit
// and never change.
function lockPath(): string {
  if (process.env.OPERATION_LOCK) return process.env.OPERATION_LOCK;
  const dir = process.env.LOCK_DIR ?? '/updater-data';
  return join(dir, 'operation.lock');
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.write(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  const dirFh = await open(dirname(path), 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}

export async function readLock(): Promise<LockInfo | null> {
  try {
    const fh = await open(lockPath(), 'r');
    try {
      const text = (await fh.readFile()).toString('utf8');
      return JSON.parse(text) as LockInfo;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export class MutexBusyError extends Error {
  constructor(public lock: LockInfo) {
    super(`operation lock held by ${lock.owner}/${lock.operation} since ${lock.startedAt}`);
    this.name = 'MutexBusyError';
  }
}

async function tryAcquire(info: LockInfo): Promise<boolean> {
  try {
    const fh = await open(lockPath(), 'wx', 0o600);
    try {
      const body = JSON.stringify(info);
      await fh.write(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EEXIST') return false;
    throw err;
  }
}

export async function withMutex<T>(operation: Operation, fn: () => Promise<T>): Promise<T> {
  const info: LockInfo = {
    owner: 'doctor',
    operation,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
  const ok = await tryAcquire(info);
  if (!ok) {
    const lock = await readLock();
    if (lock) throw new MutexBusyError(lock);
    // racy read; assume held
    throw new MutexBusyError({
      owner: 'doctor',
      operation: 'recover',
      startedAt: new Date().toISOString(),
    });
  }
  try {
    return await fn();
  } finally {
    try {
      await unlink(lockPath());
    } catch {
      // best-effort
    }
  }
}

export async function forceClear(): Promise<void> {
  try {
    await unlink(lockPath());
  } catch {
    // already clear
  }
}

export async function writeLockInfo(info: LockInfo): Promise<void> {
  await writeAtomic(lockPath(), JSON.stringify(info));
}
