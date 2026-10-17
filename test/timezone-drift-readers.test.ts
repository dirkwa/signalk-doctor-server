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

/** Build a fake dockerode client. listContainers() resolves `listed` (an
 *  Error → thrown); by default it lists every `behavior` key, Docker-style
 *  with a leading slash. getContainer(name).inspect() is driven by
 *  `behavior[name]`: an object → resolved inspect value; an Error → thrown;
 *  absent → not-found. `inspected` records every name asked for, and
 *  `listOptions` every options object listContainers() was called with. */
function fakeRuntime(
  behavior: Record<string, unknown | Error>,
  listed: unknown = Object.keys(behavior).map((name) => ({ Names: [`/${name}`] })),
) {
  const inspected: string[] = [];
  const listOptions: unknown[] = [];
  return {
    kind: 'podman',
    inspected,
    listOptions,
    client: {
      listContainers: async (options?: unknown) => {
        listOptions.push(options);
        if (listed instanceof Error) throw listed;
        return listed;
      },
      getContainer: (name: string) => ({
        inspect: async () => {
          inspected.push(name);
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

  it('reads TZ from the listed managed peers by their real names', async () => {
    resolveRuntime.mockResolvedValue(
      fakeRuntime({
        'sk-signalk-questdb': { Config: { Env: ['FOO=1', 'TZ=Europe/Berlin'] } },
        'sk-mayara-server': { Config: { Env: ['TZ=Europe/Lisbon'] } },
      }),
    );
    const r = await readPeerZones();
    expect(r.error).toBeNull();
    expect(r.peers).toEqual({
      'sk-signalk-questdb': 'Europe/Berlin',
      'sk-mayara-server': 'Europe/Lisbon',
    });
  });

  it('inspects only listed sk- peers, never jobs or other containers', async () => {
    // The regression: a hard-coded name list inspected `questdb`/`grafana`/…
    // on every probe run — names no managed container has — so each run was
    // a burst of 404s and the real `sk-*` peers were never checked.
    const rt = fakeRuntime({ 'sk-whisper': { Config: { Env: ['TZ=Europe/Berlin'] } } }, [
      { Names: ['/sk-whisper'] },
      { Names: ['/sk-job-0123abcd'] },
      { Names: ['/signalk-server'] },
      { Names: ['/devpod-sk-questdb'] },
    ]);
    resolveRuntime.mockResolvedValue(rt);
    const r = await readPeerZones();
    expect(r.peers).toEqual({ 'sk-whisper': 'Europe/Berlin' });
    expect(rt.inspected).toEqual(['sk-whisper']);
  });

  it('lists running containers only', async () => {
    // A stopped peer's zone has no effect until it runs; listing with
    // `all: true` would report it as drift.
    const rt = fakeRuntime({});
    resolveRuntime.mockResolvedValue(rt);
    await readPeerZones();
    expect(rt.listOptions).toHaveLength(1);
    expect(rt.listOptions[0]).not.toHaveProperty('all', true);
  });

  it('reports a failed list as an error with no peers', async () => {
    resolveRuntime.mockResolvedValue(fakeRuntime({}, new Error('connect ECONNREFUSED')));
    const r = await readPeerZones();
    expect(r.peers).toEqual({});
    expect(r.error).toContain('listing containers');
  });

  it('omits a peer removed between the list and its inspect', async () => {
    resolveRuntime.mockResolvedValue(fakeRuntime({}, [{ Names: ['/sk-piper'] }]));
    const r = await readPeerZones();
    expect(r.error).toBeNull();
    expect(r.peers).toEqual({});
  });

  it('records a running peer with no TZ as null', async () => {
    resolveRuntime.mockResolvedValue(
      fakeRuntime({ 'sk-signalk-questdb': { Config: { Env: ['FOO=1'] } } }),
    );
    const r = await readPeerZones();
    expect(r.peers).toEqual({ 'sk-signalk-questdb': null });
  });

  it('accumulates errors but keeps reading later peers (no early return)', async () => {
    // The first peer errors; the second must still be read. This is the
    // property the early-return version got wrong.
    resolveRuntime.mockResolvedValue(
      fakeRuntime({
        'sk-a-questdb': new Error('permission denied talking to socket'),
        'sk-b-grafana': { Config: { Env: ['TZ=Europe/Berlin'] } },
      }),
    );
    const r = await readPeerZones();
    expect(r.peers).toEqual({ 'sk-b-grafana': 'Europe/Berlin' });
    expect(r.error).toContain('sk-a-questdb');
  });

  it('flags a malformed inspect payload without asserting its shape', async () => {
    resolveRuntime.mockResolvedValue(
      fakeRuntime({
        'sk-signalk-questdb': { Config: { Env: 'not-an-array' } },
        'sk-signalk-grafana': { Config: { Env: ['TZ=Europe/Berlin'] } },
      }),
    );
    const r = await readPeerZones();
    expect(r.peers).toEqual({ 'sk-signalk-grafana': 'Europe/Berlin' });
    expect(r.error).toContain('malformed');
  });
});
