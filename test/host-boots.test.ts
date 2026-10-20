import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hostBootsPath,
  installCleanStopHandlers,
  loadHostBoots,
  markCleanStopSync,
  noteUnderVoltage,
  recordBoot,
  resetHostBootsForTest,
} from '../src/host-boots.js';
import { probeHostRestarts } from '../src/probes/host-restarts.js';

const BOOT_A = '11111111-1111-4111-8111-111111111111';
const BOOT_B = '22222222-2222-4222-8222-222222222222';
// 2026-10-20T00:00:00Z
const BTIME = 1792454400;

describe('host boot tracking', () => {
  let dir: string;
  const prev: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'host-boots-'));
    for (const k of ['DOCTOR_DATA', 'HOST_PROC']) prev[k] = process.env[k];
    process.env.DOCTOR_DATA = join(dir, 'data');
    process.env.HOST_PROC = join(dir, 'proc');
    await mkdir(join(dir, 'data'), { recursive: true });
    await mkdir(join(dir, 'proc/sys/kernel/random'), { recursive: true });
    await writeFile(join(dir, 'proc/sys/kernel/osrelease'), '6.12.47+rpt-rpi-2712\n');
    await writeFile(join(dir, 'proc/stat'), `cpu  1 2 3 4\nbtime ${BTIME}\nprocesses 1\n`);
    resetHostBootsForTest();
  });

  afterEach(async () => {
    for (const k of ['DOCTOR_DATA', 'HOST_PROC']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  const boot = (id: string) => writeFile(join(dir, 'proc/sys/kernel/random/boot_id'), `${id}\n`);
  const at = (iso: string) => new Date(iso);

  it('starts tracking on the first run without counting anything', async () => {
    await boot(BOOT_A);
    const s = await recordBoot(at('2026-10-20T08:00:00Z'));
    expect(s).toMatchObject({
      bootId: BOOT_A,
      cleanStop: false,
      trackingSince: '2026-10-20T08:00:00.000Z',
      unclean: [],
    });
    expect(await loadHostBoots()).toEqual(s);
  });

  it('does not count a doctor restart within the same boot', async () => {
    await boot(BOOT_A);
    await recordBoot(at('2026-10-20T08:00:00Z'));
    resetHostBootsForTest();
    const s = await recordBoot(at('2026-10-20T09:00:00Z'));
    expect(s?.unclean).toEqual([]);
    expect(s?.trackingSince).toBe('2026-10-20T08:00:00.000Z');
  });

  it('does not count a new boot after a clean stop', async () => {
    await boot(BOOT_A);
    await recordBoot(at('2026-10-20T08:00:00Z'));
    markCleanStopSync();
    expect((await loadHostBoots())?.cleanStop).toBe(true);
    resetHostBootsForTest();
    await boot(BOOT_B);
    const s = await recordBoot(at('2026-10-20T10:00:00Z'));
    expect(s?.unclean).toEqual([]);
    expect(s?.bootId).toBe(BOOT_B);
  });

  it('counts a new boot whose previous record was never marked cleanly stopped', async () => {
    await boot(BOOT_A);
    await recordBoot(at('2026-10-20T08:00:00Z'));
    resetHostBootsForTest();
    await boot(BOOT_B);
    const s = await recordBoot(at('2026-10-20T10:00:00Z'));
    expect(s?.unclean).toEqual([
      {
        bootId: BOOT_A,
        doctorStartedAt: '2026-10-20T08:00:00.000Z',
        hostBootedAt: new Date(BTIME * 1000).toISOString(),
        detectedAt: '2026-10-20T10:00:00.000Z',
        underVoltageAt: null,
      },
    ]);
  });

  it('stores the first under-voltage of a boot once and carries it into the unclean entry', async () => {
    await boot(BOOT_A);
    await recordBoot(at('2026-10-20T08:00:00Z'));
    expect(noteUnderVoltage(at('2026-10-20T08:30:00Z'))).toBe(true);
    expect(noteUnderVoltage(at('2026-10-20T08:31:00Z'))).toBe(false);
    expect((await loadHostBoots())?.underVoltageAt).toBe('2026-10-20T08:30:00.000Z');
    resetHostBootsForTest();
    await boot(BOOT_B);
    const s = await recordBoot(at('2026-10-20T10:00:00Z'));
    expect(s?.underVoltageAt).toBeNull();
    expect(s?.unclean.at(-1)?.underVoltageAt).toBe('2026-10-20T08:30:00.000Z');
  });

  it('keeps the under-voltage time across a doctor restart within the same boot', async () => {
    await boot(BOOT_A);
    await recordBoot(at('2026-10-20T08:00:00Z'));
    noteUnderVoltage(at('2026-10-20T08:30:00Z'));
    resetHostBootsForTest();
    const s = await recordBoot(at('2026-10-20T09:00:00Z'));
    expect(s?.underVoltageAt).toBe('2026-10-20T08:30:00.000Z');
  });

  it('reads a record written before underVoltageAt existed', async () => {
    await writeFile(
      hostBootsPath(),
      JSON.stringify({
        version: 1,
        bootId: BOOT_A,
        startedAt: '2026-10-19T08:00:00.000Z',
        cleanStop: false,
        trackingSince: '2026-10-19T08:00:00.000Z',
        unclean: [
          {
            bootId: BOOT_B,
            doctorStartedAt: '2026-10-18T08:00:00.000Z',
            hostBootedAt: null,
            detectedAt: '2026-10-19T08:00:00.000Z',
          },
        ],
      }),
    );
    const s = await loadHostBoots();
    expect(s?.underVoltageAt).toBeNull();
    expect(s?.unclean[0]?.underVoltageAt).toBeNull();
  });

  it('keeps the newest 20 unclean restarts', async () => {
    const ids = Array.from(
      { length: 23 },
      (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
    );
    for (const [i, id] of ids.entries()) {
      resetHostBootsForTest();
      await boot(id);
      await recordBoot(at(`2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
    }
    const s = await loadHostBoots();
    expect(s?.unclean).toHaveLength(20);
    expect(s?.unclean.at(-1)?.bootId).toBe(ids[21]);
  });

  it('starts over when the stored record is not valid JSON', async () => {
    await writeFile(hostBootsPath(), '{not json');
    await boot(BOOT_A);
    const s = await recordBoot(at('2026-10-20T08:00:00Z'));
    expect(s?.unclean).toEqual([]);
    expect(s?.trackingSince).toBe('2026-10-20T08:00:00.000Z');
  });

  it('records nothing under WSL', async () => {
    await writeFile(join(dir, 'proc/sys/kernel/osrelease'), '6.6.87.2-microsoft-standard-WSL2\n');
    await boot(BOOT_A);
    expect(await recordBoot()).toBeNull();
    await expect(readFile(hostBootsPath(), 'utf8')).rejects.toThrow();
  });

  it('records nothing when the boot ID is unreadable', async () => {
    expect(await recordBoot()).toBeNull();
    await expect(readFile(hostBootsPath(), 'utf8')).rejects.toThrow();
  });

  it('marks the clean stop on SIGTERM, then re-raises the signal', async () => {
    await boot(BOOT_A);
    await recordBoot(at('2026-10-20T08:00:00Z'));
    const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    installCleanStopHandlers(proc as unknown as Parameters<typeof installCleanStopHandlers>[0]);
    proc.emit('SIGTERM');
    expect((await loadHostBoots())?.cleanStop).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });

  describe('host-restarts probe', () => {
    it("is 'unknown' before the first boot record exists", async () => {
      const r = await probeHostRestarts();
      expect(r.id).toBe('host-restarts');
      expect(r.status).toBe('unknown');
    });

    it("is 'ok' with no unclean restart", async () => {
      await boot(BOOT_A);
      await recordBoot(at('2026-10-20T08:00:00Z'));
      const r = await probeHostRestarts(at('2026-10-21T08:00:00Z'));
      expect(r.status).toBe('ok');
      expect(r.message).toBe(
        'No restart without a clean shutdown in the last 7 days; tracking since 2026-10-20T08:00:00.000Z',
      );
    });

    it('warns about an unclean restart within the last 7 days', async () => {
      await boot(BOOT_A);
      await recordBoot(at('2026-10-20T08:00:00Z'));
      resetHostBootsForTest();
      await boot(BOOT_B);
      await recordBoot(at('2026-10-20T10:00:00Z'));
      const r = await probeHostRestarts(at('2026-10-21T08:00:00Z'));
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/without a clean shutdown once in the last 7 days/);
      expect(r.message).toContain(`back up at ${new Date(BTIME * 1000).toISOString()}`);
    });

    it('names the under-voltage the Pi reported during the boot that ended uncleanly', async () => {
      await boot(BOOT_A);
      await recordBoot(at('2026-10-20T08:00:00Z'));
      noteUnderVoltage(at('2026-10-20T08:30:00Z'));
      resetHostBootsForTest();
      await boot(BOOT_B);
      await recordBoot(at('2026-10-20T10:00:00Z'));
      const r = await probeHostRestarts(at('2026-10-21T08:00:00Z'));
      expect(r.status).toBe('warn');
      expect(r.message).toContain(
        'The Pi reported under-voltage during that boot, first at 2026-10-20T08:30:00.000Z.',
      );
    });

    it("goes back to 'ok' once the restart is older than 7 days, and counts it as earlier", async () => {
      await boot(BOOT_A);
      await recordBoot(at('2026-10-01T08:00:00Z'));
      resetHostBootsForTest();
      await boot(BOOT_B);
      await recordBoot(at('2026-10-01T10:00:00Z'));
      const r = await probeHostRestarts(at('2026-10-20T08:00:00Z'));
      expect(r.status).toBe('ok');
      expect(r.message).toMatch(/\(1 earlier\)/);
    });

    it("is 'ok' and untracked under WSL", async () => {
      await writeFile(join(dir, 'proc/sys/kernel/osrelease'), '6.6.87.2-microsoft-standard-WSL2\n');
      const r = await probeHostRestarts();
      expect(r.status).toBe('ok');
      expect(r.message).toMatch(/^Not tracked under WSL/);
    });
  });
});
