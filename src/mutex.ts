import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export type Operation =
  | 'switch'
  | 'rollback'
  | 'self-update'
  | 'hardware-apply'
  | 'recover'
  | 'installer-refresh'
  | 'heal-plugin-deps';

export interface LockInfo {
  owner: 'updater' | 'doctor';
  operation: Operation;
  startedAt: string;
  pid?: number;
  /** Unique per acquisition. release() only unlinks when the lock on disk
   *  still carries this nonce, so a stale handle (lock force-cleared and
   *  re-acquired by someone else while the old operation was still
   *  settling) can never delete the new owner's lock. Optional because the
   *  updater writes LockInfo without it. */
  nonce?: string;
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
  const state = await readLockState();
  return state.kind === 'lock' ? state.lock : null;
}

type LockState = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'lock'; lock: LockInfo };

/** Like readLock(), but keeps "no lock file" distinguishable from "a lock
 *  file exists that we cannot read or parse". release() needs the
 *  difference: an unreadable lock proves nothing about ownership, so it
 *  must be left in place, while an absent one simply means nothing to do. */
async function readLockState(): Promise<LockState> {
  let text: string;
  try {
    const fh = await open(lockPath(), 'r');
    try {
      text = (await fh.readFile()).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch (err) {
    return (err as { code?: string }).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable' };
  }
  try {
    return { kind: 'lock', lock: JSON.parse(text) as LockInfo };
  } catch {
    return { kind: 'unreadable' };
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

export interface MutexHandle {
  release: () => Promise<void>;
}

/** Acquire the shared operation lock and return an explicit release handle.
 *  For callers whose work can outlive the acquiring request — e.g. a heal
 *  whose `npm update` may still be running in the container after a timeout
 *  — releasing must be a decision, not a finally: dropping the lock while
 *  the child still mutates the tree would let the updater run concurrently
 *  against the same node_modules (the exact corruption CC-5 exists to
 *  prevent). Prefer withMutex() when the work is strictly request-scoped. */
export async function acquireMutex(operation: Operation): Promise<MutexHandle> {
  const info: LockInfo = {
    owner: 'doctor',
    operation,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    nonce: randomUUID(),
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
  let released = false;
  return {
    release: async () => {
      // One-shot and ownership-verified: only remove the lock while it is
      // provably still OURS. If it was force-cleared and re-acquired by
      // another operation while this one settled, unlinking blindly would
      // delete the new owner's lock and reopen the concurrent-mutation
      // window CC-5 exists to close. An UNREADABLE lock proves nothing
      // about ownership, so it is left in place too (force-clear is the
      // operator's escape hatch). The read-then-unlink pair is still a
      // narrow race — the shared protocol with the updater is existence-
      // based, and the filesystem offers no compare-and-delete — but the
      // nonce check shrinks the exposure from the whole operation's
      // duration to the microseconds between the two syscalls, reachable
      // only after an operator already force-cleared mid-operation.
      if (released) return;
      released = true;
      try {
        const state = await readLockState();
        if (state.kind !== 'lock' || state.lock.nonce !== info.nonce) return;
        await unlink(lockPath());
      } catch {
        // best-effort
      }
    },
  };
}

export async function withMutex<T>(operation: Operation, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireMutex(operation);
  try {
    return await fn();
  } finally {
    await handle.release();
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
