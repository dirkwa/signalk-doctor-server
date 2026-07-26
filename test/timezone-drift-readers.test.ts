import { describe, it, expect, vi, beforeEach } from 'vitest';

// Exercise the REAL readServerZone / readPeerZones (the probeTimezoneDrift
// suite injects gatherSources wholesale, so these readers had no direct
// coverage). We mock the podman exec + client layer they sit on.

const { execInContainer } = vi.hoisted(() => ({ execInContainer: vi.fn() }));
const { resolveRuntime } = vi.hoisted(() => ({ resolveRuntime: vi.fn() }));

vi.mock('../src/podman/exec.js', () => ({ execInContainer }));
vi.mock('../src/podman/client.js', async (importOriginal) => {
  // Keep the real `safe` (it categorizes thrown errors) but stub runtime.
  const actual = await importOriginal<typeof import('../src/podman/client.js')>();
  return { ...actual, resolveRuntime };
});

import { readServerZone, readPeerZones } from '../src/probes/timezone-drift.js';

/** Build a fake dockerode client whose getContainer(name).inspect() is driven
 *  by `behavior[name]`: an object → resolved inspect value; an Error → thrown. */
function fakeRuntime(behavior: Record<string, unknown | Error>) {
  return {
    kind: 'podman',
    client: {
      getContainer: (name: string) => ({
        inspect: async () => {
          const b = behavior[name];
          if (b === undefined) {
            const err = new Error(`no such container: ${name}`);
            throw err;
          }
          if (b instanceof Error) throw b;
          return b;
        },
      }),
    },
  };
}

beforeEach(() => {
  execInContainer.mockReset();
  resolveRuntime.mockReset();
});

describe('readServerZone', () => {
  it('returns the Intl zone signalk-server reports', async () => {
    execInContainer.mockResolvedValue({ ok: true, output: 'Europe/Berlin\n' });
    const r = await readServerZone();
    expect(r).toEqual({ zone: 'Europe/Berlin', error: null });
  });

  it('returns a null zone with a reason when the exec fails', async () => {
    execInContainer.mockResolvedValue({ ok: false, reason: 'unreachable', detail: 'no socket' });
    const r = await readServerZone();
    expect(r.zone).toBeNull();
    expect(r.error).toContain('unreachable');
  });

  it('treats empty Intl output as unreadable', async () => {
    execInContainer.mockResolvedValue({ ok: true, output: '  \n' });
    const r = await readServerZone();
    expect(r.zone).toBeNull();
    expect(r.error).toContain('empty');
  });
});

describe('readPeerZones', () => {
  it('returns {} when there is no runtime', async () => {
    resolveRuntime.mockResolvedValue(null);
    expect(await readPeerZones()).toEqual({ peers: {}, error: null });
  });

  it('reads TZ from present peers and omits not-installed ones', async () => {
    resolveRuntime.mockResolvedValue(
      fakeRuntime({
        questdb: { Config: { Env: ['FOO=1', 'TZ=Europe/Berlin'] } },
        grafana: { Config: { Env: ['TZ=Europe/Lisbon'] } },
        // 'node-red' and 'wyoming-satellite' absent → not-found → omitted
      }),
    );
    const r = await readPeerZones();
    expect(r.error).toBeNull();
    expect(r.peers).toEqual({ questdb: 'Europe/Berlin', grafana: 'Europe/Lisbon' });
  });

  it('records a present peer with no TZ as null', async () => {
    resolveRuntime.mockResolvedValue(fakeRuntime({ questdb: { Config: { Env: ['FOO=1'] } } }));
    const r = await readPeerZones();
    expect(r.peers).toEqual({ questdb: null });
  });

  it('accumulates errors but keeps reading later peers (no early return)', async () => {
    // questdb errors; grafana must still be read. This is the property the
    // early-return version got wrong.
    resolveRuntime.mockResolvedValue(
      fakeRuntime({
        questdb: new Error('permission denied talking to socket'),
        grafana: { Config: { Env: ['TZ=Europe/Berlin'] } },
      }),
    );
    const r = await readPeerZones();
    expect(r.peers).toEqual({ grafana: 'Europe/Berlin' });
    expect(r.error).toContain('questdb');
  });

  it('flags a malformed inspect payload without asserting its shape', async () => {
    resolveRuntime.mockResolvedValue(
      fakeRuntime({
        questdb: { Config: { Env: 'not-an-array' } },
        grafana: { Config: { Env: ['TZ=Europe/Berlin'] } },
      }),
    );
    const r = await readPeerZones();
    expect(r.peers).toEqual({ grafana: 'Europe/Berlin' });
    expect(r.error).toContain('malformed');
  });
});
