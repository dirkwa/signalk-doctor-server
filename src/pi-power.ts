import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { noteUnderVoltage } from './host-boots.js';

// Raspberry Pi power and temperature, read through the doctor quadlet's
// Volume=/sys:/host/sys:ro. The firmware's throttled flags reach sysfs in one
// place only: the raspberrypi-hwmon driver (hwmon device "rpi_volt") asks the
// firmware for them every 2 s, clearing the sticky bits with each request, and
// exposes the under-voltage sticky bit of the latest answer as in0_lcrit_alarm
// (raspberrypi/linux rpi-6.12.y, drivers/hwmon/raspberrypi-hwmon.c). The
// attribute therefore means "under-voltage within the driver's last 2 s
// window", and reading it returns the driver's cached value without a firmware
// call. Frequency capping, throttling and the soft temperature limit are only
// reachable through /dev/vcio (vcgencmd), which this container does not get.

// Read per call so tests can point it at a fixture tree.
const sysRoot = (): string => process.env.HOST_SYS ?? '/host/sys';

/** The devicetree model names the board, e.g. "Raspberry Pi 5 Model B Rev 1.0".
 *  A host without a devicetree (an x86 PC) has no model file, which answers
 *  false; any other read failure answers null. */
export async function isRaspberryPi(): Promise<boolean | null> {
  try {
    const model = await readFile(join(sysRoot(), 'firmware/devicetree/base/model'), 'utf8');
    return /raspberry pi/i.test(model);
  } catch (err) {
    return (err as { code?: unknown }).code === 'ENOENT' ? false : null;
  }
}

/** The hwmon directory of the rpi_volt device, or null when the driver is not
 *  loaded (not a Pi, or the module is missing). */
export async function findRpiVolt(): Promise<string | null> {
  const base = join(sysRoot(), 'class/hwmon');
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const dir = join(base, entry);
    try {
      if ((await readFile(join(dir, 'name'), 'utf8')).trim() === 'rpi_volt') return dir;
    } catch {
      // not a readable hwmon entry
    }
  }
  return null;
}

/** true when the driver's latest 2 s window saw under-voltage; null when
 *  unreadable. */
export async function readUnderVoltageAlarm(dir: string): Promise<boolean | null> {
  try {
    const v = (await readFile(join(dir, 'in0_lcrit_alarm'), 'utf8')).trim();
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

/** CPU temperature in °C from the thermal zone of type "cpu-thermal", the
 *  name the Pi device trees give it (bcm283x.dtsi for the Pi 3 and 4,
 *  bcm2712-ds.dtsi for the Pi 5); null when there is no such zone. */
export async function readCpuTempC(): Promise<number | null> {
  const base = join(sysRoot(), 'class/thermal');
  let zones: string[];
  try {
    zones = (await readdir(base)).filter((z) => z.startsWith('thermal_zone')).sort();
  } catch {
    return null;
  }
  for (const zone of zones) {
    try {
      if ((await readFile(join(base, zone, 'type'), 'utf8')).trim() !== 'cpu-thermal') continue;
      const milli = Number((await readFile(join(base, zone, 'temp'), 'utf8')).trim());
      return Number.isFinite(milli) ? milli / 1000 : null;
    } catch {
      // unreadable zone; keep looking
    }
  }
  return null;
}

/** One sample: store the time of the first under-voltage this boot. */
export async function sampleUnderVoltage(dir: string, now = new Date()): Promise<void> {
  if ((await readUnderVoltageAlarm(dir)) === true) noteUnderVoltage(now);
}

interface SamplerLog {
  warn: (obj: object, msg: string) => void;
}

/** Samples the under-voltage alarm now and every second, so the boot record
 *  keeps every dip the driver reports: the alarm stays set for one 2 s driver
 *  window, which a 1 s sample cannot miss. Each sample is one read of a cached
 *  sysfs value; the record is written once per boot, at the first sighting.
 *  Does nothing when rpi_volt is absent. Returns a stop function. */
export async function startUnderVoltageSampler(
  log: SamplerLog,
  intervalMs = 1_000,
): Promise<() => void> {
  const dir = await findRpiVolt();
  if (!dir) return () => {};
  // A failing write repeats every second while the alarm is set; log it once.
  let warned = false;
  const sample = (): void => {
    sampleUnderVoltage(dir).catch((err: unknown) => {
      if (warned) return;
      warned = true;
      log.warn({ err }, 'under-voltage sample not stored');
    });
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
