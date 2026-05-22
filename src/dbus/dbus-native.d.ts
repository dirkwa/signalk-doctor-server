// Minimal ambient module declaration for @homebridge/dbus-native — the package
// ships no types of its own. We type only the small surface we use.

declare module '@homebridge/dbus-native' {
  export interface DBusMessage {
    destination: string;
    path: string;
    interface: string;
    member: string;
    signature?: string;
    body?: unknown[];
  }

  export interface DBusConnection {
    end(): void;
  }

  export interface DBusBus {
    invoke<T = unknown>(msg: DBusMessage, cb: (err: Error | null, result: T) => void): void;
    connection: DBusConnection;
  }

  export interface BusOptions {
    busAddress?: string;
    /**
     * Authentication methods to attempt, in order. Default is
     * ['EXTERNAL', 'DBUS_COOKIE_SHA1', 'ANONYMOUS']. Force EXTERNAL
     * only when running in a distroless container that lacks
     * /root/.dbus-keyrings.
     */
    authMethods?: Array<'EXTERNAL' | 'DBUS_COOKIE_SHA1' | 'ANONYMOUS'>;
  }

  export function sessionBus(opts?: BusOptions): DBusBus;
  export function systemBus(): DBusBus;

  const _default: {
    sessionBus: typeof sessionBus;
    systemBus: typeof systemBus;
  };
  export default _default;
}
