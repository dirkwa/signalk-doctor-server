// systemd user-bus client for `daemon-reload` + `restart <unit>`.
// Uses @homebridge/dbus-native against the bind-mounted session bus at /host/dbus.
//
// The session bus address is set by the container Quadlet via:
//   Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/host/dbus
//
// If the env var is missing, sysd1Connect throws — surfaced as an error to the
// caller (versions/switch path) which translates it into a "DBus unreachable"
// SwitchResult.
//
// EXTERNAL-auth uid trick: in a rootless-podman userns the container process
// runs as in-container uid 0, but the kernel presents the bus daemon with the
// HOST uid via SCM_CREDENTIALS. dbus-native sends process.getuid() (= 0) by
// default which the bus then rejects. We override by patching process.getuid
// at module load to return the uid the host-side dbus socket actually owns.

import dbus from '@homebridge/dbus-native';
import { statSync } from 'node:fs';

const SYSD = {
  bus: 'org.freedesktop.systemd1',
  obj: '/org/freedesktop/systemd1',
  iface: 'org.freedesktop.systemd1.Manager',
} as const;

// Override process.getuid() to return the uid of whoever owns the bus socket.
// dbus-native's EXTERNAL auth handshake sends process.getuid() as the
// declared uid; in a rootless-podman userns that returns 0 (in-container
// root), but the bus daemon needs to see the host uid that owns the socket
// (the SCM_CREDENTIALS view) — they're the same person, just different
// numbers in different namespaces.
let uidOverrideApplied = false;
function applyUidOverride(busAddress: string): void {
  if (uidOverrideApplied) return;
  uidOverrideApplied = true;
  const sockPath = busAddress.replace(/^unix:path=/, '');
  try {
    const ownerUid = statSync(sockPath).uid;
    if (typeof process.getuid === 'function') {
      const realGetuid = process.getuid.bind(process);
      process.getuid = ((): number => {
        // Return the bus-socket owner's uid only for the immediate dbus-
        // native handshake; other code paths that ask for the real uid
        // can still get it by calling process.getuid.real() if we ever
        // need that. For our use it's safe to always return the override.
        return ownerUid;
      }) as typeof process.getuid;
      // Stash the original in case anything else needs it.
      (process.getuid as unknown as { real?: () => number }).real = realGetuid;
    }
  } catch {
    // Can't stat the socket — keep dbus-native's default getuid behavior.
  }
}

function sessionBus(): ReturnType<typeof dbus.sessionBus> {
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!addr) throw new Error('DBUS_SESSION_BUS_ADDRESS not set');
  applyUidOverride(addr);
  // Force EXTERNAL auth only. The library's default fallback chain attempts
  // DBUS_COOKIE_SHA1 which stat()s /root/.dbus-keyrings; on a distroless
  // Chainguard image that directory does not exist and the resulting
  // ENOENT propagates as an uncaught 'error' event that kills the Node
  // process. EXTERNAL is the only method that works for a socket bind-
  // mount anyway (the kernel passes uid via SCM_CREDENTIALS).
  return dbus.sessionBus({ busAddress: addr, authMethods: ['EXTERNAL'] });
}

interface Invoker {
  invoke<T>(method: string, signature: string, body: unknown[]): Promise<T>;
  end(): void;
}

function getInvoker(): Invoker {
  const bus = sessionBus();
  // Catch EventEmitter 'error' events emitted by the underlying socket so
  // an auth failure can't kill the Node process. The invoke() callback
  // receives the same error and propagates it as a normal Promise reject.
  // Cast to EventEmitter shape since dbus-native's type doesn't expose .on.
  const conn = bus.connection as unknown as {
    on(event: 'error', cb: (err: Error) => void): void;
  };
  conn.on('error', () => {
    /* swallow — surfaced via invoke() callback */
  });
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
      try {
        bus.connection.end();
      } catch {
        // already closed
      }
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
