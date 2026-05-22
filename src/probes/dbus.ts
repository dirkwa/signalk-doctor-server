import { stat } from 'node:fs/promises';
import type { ProbeResult } from './types.js';

const DBUS_PATH = process.env.DBUS_SOCKET_PATH ?? '/host/dbus';

export async function probeDbus(): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const s = await stat(DBUS_PATH);
    if (!s.isSocket()) {
      return {
        id: 'dbus',
        label: 'User-instance DBus socket',
        status: 'fail',
        message: `${DBUS_PATH} exists but is not a socket`,
        durationMs: Date.now() - t0,
      };
    }
    return {
      id: 'dbus',
      label: 'User-instance DBus socket',
      status: 'ok',
      message: `socket present at ${DBUS_PATH}`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      id: 'dbus',
      label: 'User-instance DBus socket',
      status: 'fail',
      message: `${DBUS_PATH} not reachable — linger may be disabled or the bus mount is missing`,
      durationMs: Date.now() - t0,
    };
  }
}
