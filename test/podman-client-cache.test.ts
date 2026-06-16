import { describe, it, expect, beforeEach, vi } from 'vitest';

// Count dockerode version() hits. version() is the call that, on podman,
// fans out `dpkg-query --search` per helper binary — the proven source of
// the load storm. The cache (with in-flight promise coalescing) must
// collapse a concurrent burst of resolveRuntime() calls — exactly what the
// probe runner's Promise.all produces — to a SINGLE version().
let versionCalls = 0;

vi.mock('dockerode', () => {
  return {
    default: class FakeDocker {
      async version() {
        versionCalls += 1;
        return { Components: [{ Name: 'Podman Engine' }], Platform: { Name: 'podman' } };
      }
    },
  };
});

vi.mock('node:fs/promises', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    stat: async () => ({ isSocket: () => true }),
  };
});

describe('resolveRuntime caching', () => {
  beforeEach(async () => {
    versionCalls = 0;
    const m = await import('../src/podman/client.js');
    m.__resetRuntimeCacheForTests();
  });

  it('collapses a concurrent burst to one version() call', async () => {
    const { resolveRuntime } = await import('../src/podman/client.js');
    const results = await Promise.all(Array.from({ length: 20 }, () => resolveRuntime()));
    expect(results.every((r) => r !== null)).toBe(true);
    // All callers get the exact same cached instance (coalesced, not 20 copies).
    expect(results.every((r) => r === results[0])).toBe(true);
    expect(results[0]?.kind).toBe('podman');
    expect(versionCalls).toBe(1);
  });

  it('returns the same cached instance on repeat calls', async () => {
    const { resolveRuntime } = await import('../src/podman/client.js');
    const a = await resolveRuntime();
    const b = await resolveRuntime();
    expect(a).toBe(b);
  });

  it('re-detects after the test reset', async () => {
    const { resolveRuntime, __resetRuntimeCacheForTests } = await import('../src/podman/client.js');
    await resolveRuntime();
    expect(versionCalls).toBe(1);
    __resetRuntimeCacheForTests();
    await resolveRuntime();
    expect(versionCalls).toBe(2);
  });
});
