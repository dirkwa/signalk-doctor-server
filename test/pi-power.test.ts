import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadHostBoots,
  noteUnderVoltage,
  recordBoot,
  resetHostBootsForTest,
} from '../src/host-boots.js';
import {
  findRpiVolt,
  readCpuTempC,
  sampleUnderVoltage,
  startUnderVoltageSampler,
} from '../src/pi-power.js';
import { probePiPower } from '../src/probes/pi-power.js';

const BOOT_A = '11111111-1111-4111-8111-111111111111';
const BOOT_B = '22222222-2222-4222-8222-222222222222';
const ENV = ['HOST_SYS', 'HOST_PROC', 'DOCTOR_DATA'] as const;

describe('Pi power and temperature', () => {
  let dir: string;
  const prev: Record<string, string | undefined> = {};
  const sys = (...p: string[]) => join(dir, 'sys', ...p);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-power-'));
    for (const k of ENV) prev[k] = process.env[k];
    process.env.HOST_SYS = sys();
    process.env.HOST_PROC = join(dir, 'proc');
    process.env.DOCTOR_DATA = join(dir, 'data');
    await mkdir(join(dir, 'data'), { recursive: true });
    await mkdir(join(dir, 'proc/sys/kernel/random'), { recursive: true });
    await writeFile(join(dir, 'proc/sys/kernel/random/boot_id'), `${BOOT_A}\n`);
    await writeFile(join(dir, 'proc/sys/kernel/osrelease'), '6.12.47+rpt-rpi-2712\n');
    await mkdir(sys('class'), { recursive: true });
    resetHostBootsForTest();
  });

  afterEach(async () => {
    for (const k of ENV) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  // A Pi's sysfs as the probe reads it: the devicetree model, a thermal hwmon
  // ahead of rpi_volt (so the lookup has to match by name), and the CPU zone.
  async function fakePi(opts: { underVoltage?: '0' | '1'; tempMilli?: string; volt?: boolean }) {
    await mkdir(sys('firmware/devicetree/base'), { recursive: true });
    await writeFile(sys('firmware/devicetree/base/model'), 'Raspberry Pi 5 Model B Rev 1.0\0');
    await mkdir(sys('class/hwmon/hwmon0'), { recursive: true });
    await writeFile(sys('class/hwmon/hwmon0/name'), 'cpu_thermal\n');
    if (opts.volt !== false) {
      await mkdir(sys('class/hwmon/hwmon1'), { recursive: true });
      await writeFile(sys('class/hwmon/hwmon1/name'), 'rpi_volt\n');
      await writeFile(sys('class/hwmon/hwmon1/in0_lcrit_alarm'), `${opts.underVoltage ?? '0'}\n`);
    }
    await mkdir(sys('class/thermal/thermal_zone0'), { recursive: true });
    await writeFile(sys('class/thermal/thermal_zone0/type'), 'cpu-thermal\n');
    await writeFile(sys('class/thermal/thermal_zone0/temp'), `${opts.tempMilli ?? '52300'}\n`);
  }

  it('finds rpi_volt by name and reads the CPU zone in °C', async () => {
    await fakePi({});
    expect(await findRpiVolt()).toBe(sys('class/hwmon/hwmon1'));
    expect(await readCpuTempC()).toBe(52.3);
  });

  it('prefers the cpu-thermal zone over thermal_zone0', async () => {
    await fakePi({});
    await writeFile(sys('class/thermal/thermal_zone0/type'), 'other\n');
    await mkdir(sys('class/thermal/thermal_zone1'), { recursive: true });
    await writeFile(sys('class/thermal/thermal_zone1/type'), 'cpu-thermal\n');
    await writeFile(sys('class/thermal/thermal_zone1/temp'), '61000\n');
    expect(await readCpuTempC()).toBe(61);
  });

  it('reports no CPU temperature when no zone is cpu-thermal', async () => {
    await fakePi({});
    await writeFile(sys('class/thermal/thermal_zone0/type'), 'pmic-thermal\n');
    expect(await readCpuTempC()).toBeNull();
  });

  it('stores the first under-voltage sample of this boot', async () => {
    await fakePi({ underVoltage: '1' });
    await recordBoot(new Date('2026-10-20T08:00:00Z'));
    const volt = sys('class/hwmon/hwmon1');
    await sampleUnderVoltage(volt, new Date('2026-10-20T08:01:00Z'));
    await sampleUnderVoltage(volt, new Date('2026-10-20T08:02:00Z'));
    expect((await loadHostBoots())?.underVoltageAt).toBe('2026-10-20T08:01:00.000Z');
  });

  it('takes its first sample at startup', async () => {
    await fakePi({ underVoltage: '1' });
    await recordBoot(new Date('2026-10-20T08:00:00Z'));
    const stop = await startUnderVoltageSampler({ warn: () => {} }, 3_600_000);
    try {
      await vi.waitFor(async () => {
        expect((await loadHostBoots())?.underVoltageAt).not.toBeNull();
      });
    } finally {
      stop();
    }
  });

  it('stores nothing while the alarm is clear', async () => {
    await fakePi({ underVoltage: '0' });
    await recordBoot(new Date('2026-10-20T08:00:00Z'));
    await sampleUnderVoltage(sys('class/hwmon/hwmon1'));
    expect((await loadHostBoots())?.underVoltageAt).toBeNull();
  });

  describe('pi-power probe', () => {
    it("is 'unknown' when the host /sys mount is missing", async () => {
      await rm(sys(), { recursive: true });
      const r = await probePiPower();
      expect(r.id).toBe('pi-power');
      expect(r.status).toBe('unknown');
      expect(r.message).toMatch(/host \/sys mount/);
    });

    it("is 'ok' on a host that is not a Pi", async () => {
      const r = await probePiPower();
      expect(r.status).toBe('ok');
      expect(r.message).toBe('Not a Raspberry Pi');
    });

    it("is 'ok' with no under-voltage since the doctor started and a normal temperature", async () => {
      await fakePi({});
      await recordBoot(new Date('2026-10-20T08:00:00Z'));
      const r = await probePiPower();
      expect(r.status).toBe('ok');
      expect(r.message).toBe(
        'No under-voltage since the doctor started at 2026-10-20T08:00:00.000Z; CPU at 52.3 °C',
      );
      expect(r.details).toEqual({
        underVoltageNow: false,
        underVoltageFirstSeenAt: null,
        watchingSince: '2026-10-20T08:00:00.000Z',
        cpuTempC: 52.3,
      });
    });

    it('says earlier dips are unknown without a boot record', async () => {
      await fakePi({});
      const r = await probePiPower();
      expect(r.status).toBe('ok');
      expect(r.message).toBe(
        'No under-voltage right now; no boot record, so earlier dips this boot are unknown; CPU at 52.3 °C',
      );
    });

    it('warns about a dip earlier this boot after the alarm has cleared', async () => {
      await fakePi({ underVoltage: '0' });
      await recordBoot(new Date('2026-10-20T08:00:00Z'));
      noteUnderVoltage(new Date('2026-10-20T08:01:00Z'));
      const r = await probePiPower();
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(
        /^Under-voltage earlier this boot, first seen 2026-10-20T08:01:00.000Z: /,
      );
      expect(r.message).toMatch(/5 V supply/);
    });

    it('warns about under-voltage right now and names the first sighting', async () => {
      await fakePi({ underVoltage: '1' });
      await recordBoot(new Date('2026-10-20T08:00:00Z'));
      await sampleUnderVoltage(sys('class/hwmon/hwmon1'), new Date('2026-10-20T08:01:00Z'));
      const r = await probePiPower();
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(
        /^Under-voltage right now, first seen this boot at 2026-10-20T08:01:00.000Z: /,
      );
    });

    it('ignores a record left from an earlier boot', async () => {
      await fakePi({ underVoltage: '0' });
      await recordBoot(new Date('2026-10-20T08:00:00Z'));
      noteUnderVoltage(new Date('2026-10-20T08:01:00Z'));
      await writeFile(join(dir, 'proc/sys/kernel/random/boot_id'), `${BOOT_B}\n`);
      const r = await probePiPower();
      expect(r.status).toBe('ok');
      expect(r.message).toMatch(/^No under-voltage right now; no boot record/);
    });

    it('warns from 80 °C, where the firmware starts throttling the Arm cores', async () => {
      await fakePi({ tempMilli: '81200' });
      const r = await probePiPower();
      expect(r.status).toBe('warn');
      expect(r.message).toBe(
        'CPU at 81.2 °C: between 80 and 85 °C the firmware throttles the Arm cores',
      );
    });

    it('says the GPU is throttled too from 85 °C', async () => {
      await fakePi({ tempMilli: '85000' });
      const r = await probePiPower();
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/from 85 °C the firmware throttles the Arm cores and the GPU/);
    });

    it('lists under-voltage and heat together', async () => {
      await fakePi({ underVoltage: '1', tempMilli: '82000' });
      const r = await probePiPower();
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/^Under-voltage right now: .*; CPU at 82.0 °C/);
    });

    it("is 'unknown', not 'Not a Raspberry Pi', when the devicetree model cannot be read", async () => {
      await mkdir(sys('firmware/devicetree/base/model'), { recursive: true });
      const r = await probePiPower();
      expect(r.status).toBe('unknown');
      expect(r.message).toMatch(/no rpi_volt hwmon device/);
    });

    it('names the unreadable alarm file when rpi_volt exists', async () => {
      await fakePi({});
      await rm(sys('class/hwmon/hwmon1/in0_lcrit_alarm'));
      const r = await probePiPower();
      expect(r.status).toBe('unknown');
      expect(r.message).toBe(
        `Cannot read ${sys('class/hwmon/hwmon1')}/in0_lcrit_alarm; CPU at 52.3 °C`,
      );
    });

    it("is 'unknown' on a Pi without the rpi_volt device", async () => {
      await fakePi({ volt: false });
      const r = await probePiPower();
      expect(r.status).toBe('unknown');
      expect(r.message).toBe(
        'Cannot read the under-voltage alarm (no rpi_volt hwmon device); CPU at 52.3 °C',
      );
    });
  });
});
