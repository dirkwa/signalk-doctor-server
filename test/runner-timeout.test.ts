import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProbeResult } from '../src/probes/types.js';

// The runner pulls its probe list from the individual probe modules at
// import time. To exercise the timeout/throw paths in isolation we mock the
// whole module graph and override one slot per case, then assert on the
// runner's observable behavior. The runner now keys degraded probes by the
// id it declares in its registry (not the function name), so a hung/thrown
// probe surfaces under the SAME id it would when healthy — that's the
// property these tests pin.

function ok(id: string): ProbeResult {
  return { id, label: id, status: 'ok', message: 'fine', durationMs: 1 };
}

/** Mock every probe module to a fast `ok` result, then apply `overrides`
 *  to swap specific probe functions for the case under test. The keys mirror
 *  the registry's run functions; ids passed to ok() are arbitrary here (the
 *  runner labels degraded probes from its OWN registry, not these). */
function mockAll(overrides: Record<string, () => Promise<ProbeResult>> = {}): void {
  const defs: Record<string, () => Promise<ProbeResult>> = {
    probePodman: () => Promise.resolve(ok('podman')),
    probeDbus: () => Promise.resolve(ok('dbus')),
    probeSignalkContainer: () => Promise.resolve(ok('container-signalk-server')),
    probeUpdaterContainer: () => Promise.resolve(ok('container-signalk-updater-server')),
    probeSignalkHealth: () => Promise.resolve(ok('signalk-health')),
    probeUpdaterHealth: () => Promise.resolve(ok('updater-health')),
    probeVersionDrift: () => Promise.resolve(ok('version-drift')),
    probeTimezoneDrift: () => Promise.resolve(ok('timezone-drift')),
    probeDependencyDrift: () => Promise.resolve(ok('dependency-drift')),
    probeSnapshots: () => Promise.resolve(ok('snapshots')),
    probeDisk: () => Promise.resolve(ok('disk')),
    probeMemory: () => Promise.resolve(ok('memory')),
    probeTimeDrift: () => Promise.resolve(ok('time-drift')),
    probeCgroupDelegation: () => Promise.resolve(ok('cgroup-delegation')),
    probeStorageType: () => Promise.resolve(ok('storage-type')),
  };
  const p = { ...defs, ...overrides };
  vi.doMock('../src/probes/podman.js', () => ({ probePodman: p.probePodman }));
  vi.doMock('../src/probes/dbus.js', () => ({ probeDbus: p.probeDbus }));
  vi.doMock('../src/probes/containers.js', () => ({
    probeSignalkContainer: p.probeSignalkContainer,
    probeUpdaterContainer: p.probeUpdaterContainer,
  }));
  vi.doMock('../src/probes/signalk-health.js', () => ({
    probeSignalkHealth: p.probeSignalkHealth,
  }));
  vi.doMock('../src/probes/updater-health.js', () => ({
    probeUpdaterHealth: p.probeUpdaterHealth,
  }));
  vi.doMock('../src/probes/version-drift.js', () => ({ probeVersionDrift: p.probeVersionDrift }));
  vi.doMock('../src/probes/timezone-drift.js', () => ({
    probeTimezoneDrift: p.probeTimezoneDrift,
  }));
  vi.doMock('../src/probes/dependency-drift.js', () => ({
    probeDependencyDrift: p.probeDependencyDrift,
  }));
  vi.doMock('../src/probes/snapshots.js', () => ({ probeSnapshots: p.probeSnapshots }));
  vi.doMock('../src/probes/disk.js', () => ({ probeDisk: p.probeDisk }));
  vi.doMock('../src/probes/memory.js', () => ({ probeMemory: p.probeMemory }));
  vi.doMock('../src/probes/time-drift.js', () => ({ probeTimeDrift: p.probeTimeDrift }));
  vi.doMock('../src/probes/cgroup-delegation.js', () => ({
    probeCgroupDelegation: p.probeCgroupDelegation,
  }));
  vi.doMock('../src/probes/storage-type.js', () => ({ probeStorageType: p.probeStorageType }));
}

describe('runAllProbes — per-probe timeout', () => {
  beforeEach(() => {
    vi.resetModules();
    // Above the 250ms floor so the override actually takes effect.
    process.env.PROBE_TIMEOUT_MS = '300';
  });
  afterEach(() => {
    delete process.env.PROBE_TIMEOUT_MS;
    vi.resetModules();
    vi.useRealTimers();
  });

  it('marks a hung probe unknown under its REGISTRY id, not its function name', async () => {
    // probePodman never settles. The runner must time it out AND surface it
    // under id 'podman' (the id the real podman probe emits), so a degraded
    // podman probe is the same key as a healthy one — the bug the adversarial
    // review confirmed.
    mockAll({ probePodman: () => new Promise<ProbeResult>(() => {}) });
    const { runAllProbes } = await import('../src/probes/runner.js');
    const out = await runAllProbes();

    const podman = out.results.find((r) => r.id === 'podman');
    expect(podman).toBeDefined();
    expect(podman?.status).toBe('unknown');
    expect(podman?.label).toBe('Container runtime');
    expect(podman?.message).toMatch(/did not finish within 300ms/);
    // No result is keyed by the function name.
    expect(out.results.some((r) => r.id === 'probePodman')).toBe(false);
    expect(out.summary.unknown).toBe(1);
    expect(out.summary.ok).toBe(14);
  });

  it('marks a throwing probe unknown under its registry id (does not reject the run)', async () => {
    mockAll({ probeDbus: () => Promise.reject(new Error('boom')) });
    const { runAllProbes } = await import('../src/probes/runner.js');
    const out = await runAllProbes();

    const dbus = out.results.find((r) => r.id === 'dbus');
    expect(dbus?.status).toBe('unknown');
    expect(dbus?.label).toBe('User-instance DBus socket');
    expect(dbus?.message).toBe('boom');
    expect(out.summary.unknown).toBe(1);
    expect(out.summary.ok).toBe(14);
  });

  it('passes fast probes through unchanged (no timeout penalty, all 15 ok)', async () => {
    mockAll();
    const { runAllProbes } = await import('../src/probes/runner.js');
    const out = await runAllProbes();
    expect(out.summary.ok).toBe(15);
    expect(out.summary.unknown).toBe(0);
    expect(out.results).toHaveLength(15);
  });
});
