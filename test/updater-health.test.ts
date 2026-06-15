import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeUpdaterHealth } from '../src/probes/updater-health.js';

const URL = 'http://updater.test:3003/api/health';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('probeUpdaterHealth', () => {
  const prevUrl = process.env.UPDATER_URL;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.UPDATER_URL = URL;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (prevUrl === undefined) delete process.env.UPDATER_URL;
    else process.env.UPDATER_URL = prevUrl;
  });

  it("reports 'ok' on a fast healthy response (single attempt)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ ok: true, runtime: 'podman' }));
    const r = await probeUpdaterHealth();
    expect(r.id).toBe('updater-health');
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/reports OK/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports 'fail' on a non-2xx without retrying (it's a real answer)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes(null, false, 503));
    const r = await probeUpdaterHealth();
    expect(r.status).toBe('fail');
    expect(r.message).toContain('HTTP 503');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports 'warn' when the updater answers ok=false", async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ ok: false, runtime: 'podman' }));
    const r = await probeUpdaterHealth();
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/ok=false/);
  });

  it("downgrades a slow-but-healthy response to 'warn' with the I/O hint", async () => {
    // Make the per-attempt clock jump past SLOW_MS (4000), into the warn band
    // below TIMEOUT_MS (5000), without real waiting.
    // Probe call order: t0, attemptStart, attemptMs-end, totalMs-end.
    const base = 1_000_000;
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(base) // t0
      .mockReturnValueOnce(base) // attemptStart
      .mockReturnValue(base + 4500); // attempt end + total end
    try {
      fetchSpy.mockResolvedValueOnce(jsonRes({ ok: true, runtime: 'podman' }));
      const r = await probeUpdaterHealth();
      expect(r.status).toBe('warn');
      expect(r.message).toMatch(/slow \(4500ms\)/);
      expect(r.message).toMatch(/Host root storage/);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('retries a transient network error, then succeeds', async () => {
    vi.useFakeTimers();
    try {
      fetchSpy
        .mockRejectedValueOnce(new Error('This operation was aborted'))
        .mockResolvedValueOnce(jsonRes({ ok: true, runtime: 'podman' }));
      const p = probeUpdaterHealth();
      await vi.runAllTimersAsync();
      const r = await p;
      expect(r.status).toBe('ok');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports 'fail' after exhausting retries", async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockRejectedValue(new Error('This operation was aborted'));
      const p = probeUpdaterHealth();
      await vi.runAllTimersAsync();
      const r = await p;
      expect(r.status).toBe('fail');
      expect(r.message).toMatch(/cannot reach/);
      // 1 initial + 2 retries
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
