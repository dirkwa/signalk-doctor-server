// systemd user-bus client for `daemon-reload` + `restart <unit>`.
// Uses @homebridge/dbus-native against the bind-mounted session bus at /host/dbus.
//
// The session bus address is set by the container Quadlet via:
//   Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/host/dbus
//
// If the env var is missing, sysd1Connect throws — surfaced as an error to the
// caller (versions/switch path) which translates it into a "DBus unreachable"
// SwitchResult.

import dbus from '@homebridge/dbus-native';

const SYSD = {
  bus: 'org.freedesktop.systemd1',
  obj: '/org/freedesktop/systemd1',
  iface: 'org.freedesktop.systemd1.Manager',
} as const;

function sessionBus(): ReturnType<typeof dbus.sessionBus> {
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!addr) throw new Error('DBUS_SESSION_BUS_ADDRESS not set');
  return dbus.sessionBus({ busAddress: addr });
}

interface Invoker {
  invoke<T>(method: string, signature: string, body: unknown[]): Promise<T>;
  end(): void;
}

function getInvoker(): Invoker {
  const bus = sessionBus();
  return {
    invoke<T>(method: string, signature: string, body: unknown[]): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        bus.invoke(
          {
            destination: SYSD.bus,
            path: SYSD.obj,
            interface: SYSD.iface,
            member: method,
            signature,
            body,
          },
          (err: Error | null, result: T) => {
            if (err) reject(err);
            else resolve(result);
          },
        );
      });
    },
    end(): void {
      bus.connection.end();
    },
  };
}

export async function daemonReload(): Promise<void> {
  const inv = getInvoker();
  try {
    await inv.invoke<void>('Reload', '', []);
  } finally {
    inv.end();
  }
}

export async function restartUnit(unit: string): Promise<void> {
  const inv = getInvoker();
  try {
    // RestartUnit(name, mode) → object path of job. mode 'replace' is the safe default.
    await inv.invoke<unknown>('RestartUnit', 'ss', [unit, 'replace']);
  } finally {
    inv.end();
  }
}

export async function startUnit(unit: string): Promise<void> {
  const inv = getInvoker();
  try {
    await inv.invoke<unknown>('StartUnit', 'ss', [unit, 'replace']);
  } finally {
    inv.end();
  }
}

export async function stopUnit(unit: string): Promise<void> {
  const inv = getInvoker();
  try {
    await inv.invoke<unknown>('StopUnit', 'ss', [unit, 'replace']);
  } finally {
    inv.end();
  }
}
