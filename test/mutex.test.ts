import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireMutex, forceClear, readLock } from '../src/mutex.js';

describe('mutex ownership', () => {
  let dir: string;
  const prev = process.env.OPERATION_LOCK;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mutex-'));
    process.env.OPERATION_LOCK = join(dir, 'operation.lock');
  });

  afterEach(async () => {
    if (prev === undefined) delete process.env.OPERATION_LOCK;
    else process.env.OPERATION_LOCK = prev;
    await rm(dir, { recursive: true, force: true });
  });

  it('a stale handle cannot release a lock re-acquired by another operation', async () => {
    // The CC-5 breach this guards: a long heal holds the lock, the operator
    // force-clears it as "stuck", the updater acquires its own lock — then
    // the heal settles and its finally fires release(). Blind unlink would
    // delete the UPDATER's lock and reopen concurrent mutation.
    const stale = await acquireMutex('heal-plugin-deps');
    await forceClear();
    const current = await acquireMutex('recover');

    await stale.release();

    const onDisk = await readLock();
    expect(onDisk?.operation).toBe('recover');
    await current.release();
    expect(await readLock()).toBeNull();
  });

  it('release is one-shot', async () => {
    const first = await acquireMutex('heal-plugin-deps');
    await first.release();
    const second = await acquireMutex('recover');
    // A second release() on the first handle must be a no-op even though a
    // lock (someone else's) exists again.
    await first.release();
    expect((await readLock())?.operation).toBe('recover');
    await second.release();
  });

  it('rejects acquisition while held and releases cleanly', async () => {
    const held = await acquireMutex('heal-plugin-deps');
    await expect(acquireMutex('recover')).rejects.toThrow(/operation lock held/);
    await held.release();
    const next = await acquireMutex('recover');
    await next.release();
  });
});
