import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeResult } from './types.js';

// Reads the host's first watchdog device through the doctor quadlet's
// Volume=/sys:/host/sys:ro (see signalk-universal-installer
// quadlets/signalk-doctor-server.container.template). `state` is "active"
// while a program, normally systemd via RuntimeWatchdogSec, holds the device;
// the installer arms it on a Raspberry Pi only.

const ID = 'hardware-watchdog';
const LABEL = 'Hardware watchdog';

// Read per call so tests can point it at a fixture tree.
const sysRoot = (): string => process.env.HOST_SYS ?? '/host/sys';

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readAttr(dir: string, name: string): Promise<string | null> {
  try {
    return (await readFile(join(dir, name), 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function probeWatchdog(): Promise<ProbeResult> {
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

  const dir = join(sysRoot(), 'class/watchdog/watchdog0');
  if (!(await isDir(dir))) {
    return result('ok', 'No hardware watchdog on this host');
  }

  const [identity, state, timeout] = await Promise.all([
    readAttr(dir, 'identity'),
    readAttr(dir, 'state'),
    readAttr(dir, 'timeout'),
  ]);
  const details = { identity, state, timeoutSec: timeout === null ? null : Number(timeout) };
  const name = identity ?? 'watchdog0';

  if (state === 'active') {
    return result(
      'ok',
      `Armed: the host resets after ${timeout ?? '?'} s without a ping (${name})`,
      details,
    );
  }
  if (state === 'inactive') {
    if (identity !== null && /BCM2835/i.test(identity)) {
      return result(
        'warn',
        'The Raspberry Pi watchdog is not armed, so a Pi whose kernel or systemd hangs stays frozen until power-cycled. ' +
          'Re-running signalk-universal-installer arms it, unless it was run with SIGNALK_NO_WATCHDOG=1',
        details,
      );
    }
    return result(
      'ok',
      `Present (${name}) but not armed; the installer arms the watchdog on a Raspberry Pi only`,
      details,
    );
  }
  return result('unknown', `Cannot read ${dir}/state`, details);
}
