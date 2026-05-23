// Adapted from signalk-container/src/log-stream-broker.ts. The engine
// container reads container logs via dockerode rather than the CLI, so
// the "spawn tail" injection point now wraps dockerode's follow-mode
// log stream instead of a child process. The fan-out, ref-counting,
// auto-respawn, and exponential-backoff behaviour are otherwise
// unchanged — same semantics, just a different transport underneath.
//
// Why we need it: every SSE client opening the Logs tab would otherwise
// open its own dockerode follow stream against the runtime daemon. The
// broker fans out a single underlying stream to N subscribers and
// transparently reconnects when a container auto-recreates between
// version switches.

import type { Readable } from 'node:stream';
import { resolveRuntime } from './podman/client.js';

const RESPAWN_DELAY_MS = 1000;
const MAX_RESPAWN_DELAY_MS = 30_000;

export interface LogSubscriber {
  /** Per-line callback. Errors caught by the broker; never crash the
   *  fan-out for other subscribers. */
  onLine: (line: string) => void;
  /** Called once when the broker is force-closed. SSE handlers flush
   *  their `event: end` frame and `end()` the response. */
  onClose?: (reason: 'container-removed' | 'engine-stopped') => void;
}

export interface LogStreamBroker {
  subscribe(sub: LogSubscriber): () => void;
  subscriberCount(): number;
  close(reason: 'container-removed' | 'engine-stopped'): void;
  isClosed(): boolean;
}

interface TailHandle {
  stop: () => void;
  /** A sentinel that distinguishes "running" from "spawn failed". The
   *  signalk-container version uses `pid === undefined` as the failure
   *  marker; we use a boolean so the dockerode path can express the
   *  same idea without a fake pid. */
  ok: boolean;
}

type SpawnTail = (
  containerName: string,
  emit: (line: string) => void,
  options: {
    startTail: number;
    onError: (msg: string) => void;
    onExit: () => void;
  },
) => TailHandle;

/**
 * dockerode-backed tail implementation. Calls
 * `container.logs({follow: true, stdout: true, stderr: true})`, splits
 * the resulting stream into lines, and emits them via `onLine`. When
 * the stream closes (container removed, restarted, daemon glitch) it
 * fires `onExit` so the broker can schedule a respawn.
 */
const defaultSpawnTail: SpawnTail = (name, emit, { startTail, onError, onExit }) => {
  // Module-level guards: dockerode is async, so we have to launch and
  // hand back a stop-handle synchronously. If the underlying logs()
  // call rejects we'll surface via onError and fire onExit on next
  // tick so the broker takes the respawn path.
  let stopped = false;
  let stream: Readable | null = null;
  let buffer = '';

  const splitLines = (chunk: string): void => {
    buffer += chunk;
    const parts = buffer.split(/\r\n|\r|\n/);
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (part.length > 0) emit(part);
    }
  };

  void (async () => {
    try {
      const rt = await resolveRuntime();
      if (!rt) {
        if (!stopped) {
          onError('container runtime not reachable');
          // Defer to a microtask so the broker can install the handle
          // and observe the failure as an exit rather than a
          // before-spawn no-op.
          queueMicrotask(onExit);
        }
        return;
      }
      const c = rt.client.getContainer(name);
      const s = (await c.logs({
        stdout: true,
        stderr: true,
        follow: true,
        tail: String(startTail) as unknown as number,
        timestamps: false,
      })) as Readable;
      if (stopped) {
        // The broker stopped us before the stream resolved. Tear it
        // down immediately rather than leaking the open follow.
        const destroyable = s as { destroy?: () => void };
        destroyable.destroy?.();
        return;
      }
      stream = s;
      s.on('data', (chunk: Buffer) => splitLines(chunk.toString('utf8')));
      s.on('end', () => {
        if (!stopped) onExit();
      });
      s.on('error', (err) => {
        if (stopped) return;
        onError(err.message);
        onExit();
      });
    } catch (err) {
      if (stopped) return;
      onError(err instanceof Error ? err.message : String(err));
      queueMicrotask(onExit);
    }
  })();

  return {
    stop: () => {
      stopped = true;
      const destroyable = stream as { destroy?: () => void } | null;
      destroyable?.destroy?.();
    },
    // Spawn is "ok" by construction here — the failure mode is async,
    // handled via onError + onExit. The broker only uses `ok === false`
    // to mean "didn't manage to start the spawn at all"; for dockerode
    // we always at least attempt it.
    ok: true,
  };
};

export function createLogStreamBroker(
  containerName: string,
  options?: {
    startTail?: number;
    spawnTail?: SpawnTail;
    onTailError?: (msg: string) => void;
    onSubscriberError?: (err: unknown, subscriberIndex: number) => void;
    respawnDelayMs?: number;
  },
): LogStreamBroker {
  const spawnTail = options?.spawnTail ?? defaultSpawnTail;
  const startTail = options?.startTail ?? 0;
  const onTailError = options?.onTailError ?? (() => undefined);
  const onSubscriberError = options?.onSubscriberError;
  const respawnDelayMs = options?.respawnDelayMs ?? RESPAWN_DELAY_MS;

  const subscribers = new Set<LogSubscriber>();
  let tail: TailHandle | null = null;
  let closed = false;
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveRespawns = 0;

  const fanOut = (line: string): void => {
    consecutiveRespawns = 0;
    let i = 0;
    for (const sub of subscribers) {
      try {
        sub.onLine(line);
      } catch (err) {
        onSubscriberError?.(err, i);
      }
      i++;
    }
  };

  const spawnIfNeeded = (): void => {
    if (tail !== null || closed) return;
    const thisTail = spawnTail(containerName, fanOut, {
      startTail,
      onError: onTailError,
      onExit: () => {
        if (tail !== thisTail) return;
        tail = null;
        scheduleRespawn();
      },
    });
    if (!thisTail.ok) {
      scheduleRespawn();
      return;
    }
    tail = thisTail;
  };

  const scheduleRespawn = (): void => {
    if (respawnTimer !== null || closed) return;
    if (subscribers.size === 0) return;
    const cap = respawnDelayMs >= RESPAWN_DELAY_MS ? MAX_RESPAWN_DELAY_MS : respawnDelayMs * 30;
    const delay = Math.min(respawnDelayMs * 2 ** consecutiveRespawns, cap);
    consecutiveRespawns++;
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      if (subscribers.size === 0) return;
      spawnIfNeeded();
    }, delay);
    respawnTimer.unref();
  };

  const stopTail = (): void => {
    if (respawnTimer !== null) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
    if (tail) {
      tail.stop();
      tail = null;
    }
  };

  return {
    subscribe(sub: LogSubscriber): () => void {
      if (closed) return () => undefined;
      subscribers.add(sub);
      spawnIfNeeded();
      return () => {
        if (!subscribers.has(sub)) return;
        subscribers.delete(sub);
        if (subscribers.size === 0) stopTail();
      };
    },

    subscriberCount(): number {
      return subscribers.size;
    },

    close(reason: 'container-removed' | 'engine-stopped'): void {
      if (closed) return;
      closed = true;
      const snapshot = Array.from(subscribers);
      subscribers.clear();
      stopTail();
      for (const sub of snapshot) {
        try {
          sub.onClose?.(reason);
        } catch (err) {
          onSubscriberError?.(err, -1);
        }
      }
    },

    isClosed(): boolean {
      return closed;
    },
  };
}

/**
 * Per-engine registry of brokers keyed by container name. Used by the
 * SSE route to share a single follow-stream across all clients that
 * happen to be tailing the same container.
 */
const brokers = new Map<string, LogStreamBroker>();

export function getOrCreateBroker(name: string, startTail = 200): LogStreamBroker {
  const existing = brokers.get(name);
  if (existing && !existing.isClosed()) return existing;
  if (existing) brokers.delete(name);
  const broker = createLogStreamBroker(name, { startTail });
  brokers.set(name, broker);
  return broker;
}

export function closeAllBrokers(reason: 'engine-stopped' = 'engine-stopped'): void {
  for (const [, broker] of brokers) broker.close(reason);
  brokers.clear();
}
