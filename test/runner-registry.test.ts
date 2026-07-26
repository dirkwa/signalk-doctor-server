import { describe, it, expect } from 'vitest';
import { runAllProbes } from '../src/probes/runner.js';

// Guard against registry drift: the runner declares each probe's id/label so
// it can label a timed-out/thrown probe the same way the probe labels itself.
// If a probe's emitted id ever diverges from the registry, a degraded run
// would key it wrong. We run the REAL probes (no host services needed — they
// each return a categorized result rather than throwing) and assert every
// result id is in the known set, with no function-name-shaped ids leaking
// through. This runs with a generous timeout so no real probe trips the
// per-probe ceiling on a slow CI box.
const EXPECTED_IDS = new Set([
  'podman',
  'dbus',
  'container-signalk-server',
  'container-signalk-updater-server',
  'signalk-health',
  'updater-health',
  'version-drift',
  'timezone-drift',
  'dependency-drift',
  'snapshots',
  'disk',
  'memory',
  'time-drift',
  'cgroup-delegation',
  'storage-type',
]);

describe('runAllProbes — registry id integrity', () => {
  it('every emitted probe id is in the known registry set', async () => {
    const prev = process.env.PROBE_TIMEOUT_MS;
    process.env.PROBE_TIMEOUT_MS = '60000';
    try {
      const out = await runAllProbes();
      expect(out.results).toHaveLength(EXPECTED_IDS.size);
      for (const r of out.results) {
        expect(EXPECTED_IDS.has(r.id)).toBe(true);
        // No function-name-shaped id (the bug we fixed: 'probePodman' etc.).
        expect(r.id).not.toMatch(/^probe[A-Z]/);
        expect(r.label.length).toBeGreaterThan(0);
      }
      // Every expected id appears exactly once.
      const ids = out.results.map((r) => r.id).sort();
      expect(ids).toEqual([...EXPECTED_IDS].sort());
    } finally {
      if (prev === undefined) delete process.env.PROBE_TIMEOUT_MS;
      else process.env.PROBE_TIMEOUT_MS = prev;
    }
  }, 90000);
});
