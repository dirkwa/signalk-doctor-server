import { describe, it, expect } from 'vitest';
import { createLogStreamBroker } from '../src/log-stream-broker.js';

describe('LogStreamBroker', () => {
  it('fans a single tail out to multiple subscribers', async () => {
    let emit: ((line: string) => void) | null = null;
    let onExitRef: (() => void) | null = null;
    let spawnCount = 0;
    const broker = createLogStreamBroker('test', {
      spawnTail: (_name, e, opts) => {
        spawnCount++;
        emit = e;
        onExitRef = opts.onExit;
        return { stop: () => undefined, ok: true };
      },
    });

    const aLines: string[] = [];
    const bLines: string[] = [];
    const unsubA = broker.subscribe({ onLine: (l) => aLines.push(l) });
    const unsubB = broker.subscribe({ onLine: (l) => bLines.push(l) });

    // First subscribe spawns the tail; second subscribe must NOT
    // spawn a second one.
    expect(spawnCount).toBe(1);
    expect(broker.subscriberCount()).toBe(2);

    emit!('hello');
    emit!('world');

    expect(aLines).toEqual(['hello', 'world']);
    expect(bLines).toEqual(['hello', 'world']);

    unsubA();
    unsubB();

    expect(broker.subscriberCount()).toBe(0);

    // Sanity touch: stop refs so eslint doesn't flag onExitRef as
    // declared-but-unused even though we don't fire it in this test.
    expect(typeof onExitRef).toBe('function');
  });

  it('respawns the tail after an exit while subscribers remain', async () => {
    const exits: number[] = [];
    let spawnCount = 0;
    let lastOnExit: (() => void) | null = null;
    const broker = createLogStreamBroker('test', {
      respawnDelayMs: 5,
      spawnTail: (_name, _emit, opts) => {
        spawnCount++;
        const me = spawnCount;
        lastOnExit = () => {
          exits.push(me);
          opts.onExit();
        };
        return { stop: () => undefined, ok: true };
      },
    });

    broker.subscribe({ onLine: () => undefined });
    expect(spawnCount).toBe(1);

    lastOnExit!();
    await new Promise((r) => setTimeout(r, 30));

    expect(spawnCount).toBe(2);
    expect(exits).toEqual([1]);

    broker.close('engine-stopped');
  });

  it('refuses subscriptions after close', () => {
    const broker = createLogStreamBroker('test', {
      spawnTail: () => ({ stop: () => undefined, ok: true }),
    });
    broker.subscribe({ onLine: () => undefined });
    broker.close('container-removed');
    expect(broker.isClosed()).toBe(true);
    const unsub = broker.subscribe({ onLine: () => undefined });
    expect(broker.subscriberCount()).toBe(0);
    // Unsubscribe should be a no-op.
    unsub();
  });

  it('schedules respawn when spawn reports ok=false', async () => {
    let calls = 0;
    const broker = createLogStreamBroker('test', {
      respawnDelayMs: 5,
      spawnTail: () => {
        calls++;
        return { stop: () => undefined, ok: calls > 2 };
      },
    });
    broker.subscribe({ onLine: () => undefined });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBeGreaterThanOrEqual(2);
    broker.close('engine-stopped');
  });
});
