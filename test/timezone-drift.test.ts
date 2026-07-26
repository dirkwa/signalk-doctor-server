import { describe, it, expect } from 'vitest';
import { probeTimezoneDrift, type TimezoneSources } from '../src/probes/timezone-drift.js';

// The probe assembles three sources (host / signalk-server / peers). We drive
// the verdict matrix by injecting a synthetic `gatherSources`, so no host
// systemd-run or podman socket is needed.

function sources(over: Partial<TimezoneSources>): TimezoneSources {
  return {
    host: { ok: true, zone: 'Europe/Berlin' },
    server: 'Europe/Berlin',
    serverError: null,
    peers: {},
    peerError: null,
    ...over,
  };
}

const run = (s: TimezoneSources) => probeTimezoneDrift({ gatherSources: async () => s });

describe('probeTimezoneDrift', () => {
  it('emits the registered id/label', async () => {
    const r = await run(sources({}));
    expect(r.id).toBe('timezone-drift');
    expect(r.label).toBe('Timezone drift');
  });

  it('ok when host, server and peers all agree', async () => {
    const r = await run(sources({ peers: { questdb: 'Europe/Berlin', grafana: 'Europe/Berlin' } }));
    expect(r.status).toBe('ok');
    expect(r.message).toContain('Europe/Berlin');
  });

  it('warns when signalk-server lags the host zone (the root case)', async () => {
    const r = await run(sources({ server: 'Europe/Lisbon' }));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('signalk-server is on Europe/Lisbon');
    expect(r.message).toContain('restart signalk-server');
    const d = r.details as { hostZone: string; serverZone: string };
    expect(d.hostZone).toBe('Europe/Berlin');
    expect(d.serverZone).toBe('Europe/Lisbon');
  });

  it('warns on a lagging peer even when signalk-server is aligned', async () => {
    const r = await run(sources({ peers: { questdb: 'Europe/Berlin', grafana: 'Europe/Lisbon' } }));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('peer grafana is on Europe/Lisbon');
  });

  it('does not double-report peers when the server itself drifts', async () => {
    // When the server drifts, the restart it prescribes fixes the peers too,
    // so we only surface the server message (peer breakdown would be noise).
    const r = await run(sources({ server: 'Europe/Lisbon', peers: { questdb: 'Europe/Lisbon' } }));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('signalk-server is on Europe/Lisbon');
    expect(r.message).not.toContain('peer questdb');
  });

  it('ok when host and server are different UTC aliases (UTC vs Etc/UTC)', async () => {
    const r = await run(sources({ host: { ok: true, zone: 'UTC' }, server: 'Etc/UTC' }));
    expect(r.status).toBe('ok');
  });

  it('WARNS when the host changed to UTC but signalk-server is still on a real zone', async () => {
    // The old early-return reported ok here; a container stuck on the old
    // non-UTC zone after the host went UTC is genuine drift.
    const r = await run(sources({ host: { ok: true, zone: 'Etc/UTC' }, server: 'Europe/Berlin' }));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('signalk-server is on Europe/Berlin');
  });

  it('treats timezone aliases as equal (US/Eastern == America/New_York)', async () => {
    const r = await run(
      sources({ host: { ok: true, zone: 'America/New_York' }, server: 'US/Eastern' }),
    );
    expect(r.status).toBe('ok');
  });

  it('warns when a running peer has no TZ set (propagation failure)', async () => {
    const r = await run(sources({ peers: { questdb: null } }));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('peer questdb has no TZ set');
  });

  it('unknown (not fail) when the host zone cannot be read', async () => {
    const r = await run(
      sources({ host: { ok: false, reason: 'timeout', detail: 'timedatectl did not finish' } }),
    );
    expect(r.status).toBe('unknown');
    expect(r.message).toContain('cannot read host timezone');
  });

  it('unknown when signalk-server zone is unreadable', async () => {
    const r = await run(sources({ server: null, serverError: 'runtime: container down' }));
    expect(r.status).toBe('unknown');
    expect(r.message).toContain("signalk-server's zone is unreadable");
    expect(r.message).toContain('container down');
  });

  it('surfaces a peer read error as a warning without masking the verdict', async () => {
    const r = await run(sources({ peerError: 'grafana: runtime: socket busy' }));
    expect(r.status).toBe('warn');
    expect(r.message).toContain("could not read every peer's zone");
  });
});
