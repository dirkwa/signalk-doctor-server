import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadHostBoots, readBootId } from '../host-boots.js';
import { findRpiVolt, isRaspberryPi, readCpuTempC, readUnderVoltageAlarm } from '../pi-power.js';
import type { ProbeResult } from './types.js';

// Under-voltage during this boot (the sampler's record plus the live alarm)
// and the current CPU temperature of a Raspberry Pi (src/pi-power.ts). Thresholds from Raspberry Pi's documentation
// (computers/raspberry-pi/frequency-management.adoc): between 80 °C and 85 °C
// the firmware progressively throttles the Arm cores, from 85 °C the GPU too.

const ID = 'pi-power';
const LABEL = 'Pi power and temperature';
const THROTTLE_C = 80;
const HARD_LIMIT_C = 85;

const sysRoot = (): string => process.env.HOST_SYS ?? '/host/sys';

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function probePiPower(): Promise<ProbeResult> {
  const t0 = Date.now();
  const result = (
    status: ProbeResult['status'],
    message: string,
    details?: Record<string, unknown>,
  ): ProbeResult => ({
    id: ID,
    label: LABEL,
    status,
    message,
    ...(details ? { details } : {}),
    durationMs: Date.now() - t0,
  });

  if (!(await isDir(join(sysRoot(), 'class')))) {
    return result(
      'unknown',
      `${sysRoot()}/class is missing — doctor container may be missing the host /sys mount; refresh the doctor quadlet via signalk-universal-installer to enable this probe`,
    );
  }

  const voltDir = await findRpiVolt();
  if (!voltDir && !(await isRaspberryPi())) {
    return result('ok', 'Not a Raspberry Pi');
  }

  const alarm = voltDir ? await readUnderVoltageAlarm(voltDir) : null;
  const tempC = await readCpuTempC();
  // The sampler's record for this boot. A record from an earlier boot (left
  // when recordBoot failed this time) says nothing about this one.
  const [state, bootId] = await Promise.all([loadHostBoots(), readBootId()]);
  const record = state && bootId !== null && state.bootId === bootId ? state : null;
  const firstSeenAt = record?.underVoltageAt ?? null;
  const temp = tempC === null ? null : `${tempC.toFixed(1)} °C`;
  const details = {
    underVoltageNow: alarm,
    underVoltageFirstSeenAt: firstSeenAt,
    watchingSince: record?.startedAt ?? null,
    cpuTempC: tempC,
  };

  const problems: string[] = [];
  if (alarm === true || firstSeenAt !== null) {
    const when =
      alarm === true
        ? `Under-voltage right now${firstSeenAt ? `, first seen this boot at ${firstSeenAt}` : ''}`
        : `Under-voltage earlier this boot, first seen ${firstSeenAt}`;
    problems.push(
      `${when}: the supply dropped below what the Pi needs, which can crash it and corrupt the SD card; check the 5 V supply and its wiring`,
    );
  }
  if (tempC !== null && tempC >= HARD_LIMIT_C) {
    problems.push(
      `CPU at ${temp}: from ${HARD_LIMIT_C} °C the firmware throttles the Arm cores and the GPU`,
    );
  } else if (tempC !== null && tempC >= THROTTLE_C) {
    problems.push(
      `CPU at ${temp}: between ${THROTTLE_C} and ${HARD_LIMIT_C} °C the firmware throttles the Arm cores`,
    );
  }
  if (problems.length > 0) return result('warn', problems.join('; '), details);

  const cpu = temp ? `; CPU at ${temp}` : '';
  if (alarm === null) {
    return result(
      'unknown',
      `Cannot read the under-voltage alarm (no rpi_volt hwmon device)${cpu}`,
      details,
    );
  }
  return result(
    'ok',
    record
      ? `No under-voltage since the doctor started at ${record.startedAt}${cpu}`
      : `No under-voltage right now; no boot record, so earlier dips this boot are unknown${cpu}`,
    details,
  );
}
