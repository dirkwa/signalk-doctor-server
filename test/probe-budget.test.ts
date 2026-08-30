import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeSignalkHealth } from '../src/probes/signalk-health.js';
import { probeUpdaterHealth } from '../src/probes/updater-health.js';
import { probeTimeoutMs, startProbeDeadline, MIN_HOP_MS } from '../src/probes/budget.js';
import { describeFetchError } from '../src/probes/fetch-error.js';

// The regression these pin: an unreachable host gateway is a BLACK HOLE, not a
// refusal — the SYN goes nowhere and nothing ever answers. Both HTTP probes
// used to burn more wall-clock on that case than the runner's per-probe budget
// allows (signalk-health: 5s HTTP + 5s HTTPS = 10s; updater-health: 3 x 5s
// plus two 1.5s backoffs = 18s), so the runner killed them and replaced a
// perfectly actionable `cannot reach <url>` with `probe did not finish within
// 8000ms`. That message sends the operator hunting a broken probe instead of a
// broken route. Each probe must now finish inside the budget and say what it
// found.
//
// Fake timers do the waiting: vitest fakes Date too, so the deadline
// arithmetic advances with the abort timers and the whole file stays instant.

/** A fetch that never answers and only settles when its AbortSignal fires —
 *  the black-holed route, as opposed to a refusal. */
function blackHole(): (url: string, init?: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
}

describe('probe budget', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('signalk-health fails inside the runner budget when both hops black-hole', async () => {
    process.env.SIGNALK_URL = 'http://sk.test:80/signalk';
    process.env.SIGNALK_HTTPS_URL = 'https://sk.test:443/signalk';
    try {
      fetchSpy.mockImplementation(blackHole());
      const p = probeSignalkHealth();
      await vi.advanceTimersByTimeAsync(30_000);
      const r = await p;

      expect(r.status).toBe('fail');
      // The verdict names the endpoint and calls the silence a timeout, so the
      // operator can tell "nothing answered" from "the service said no".
      expect(r.message).toMatch(/cannot reach signalk-server/);
      expect(r.message).toContain('http://sk.test:80/signalk');
      expect(r.message).toMatch(/timed out/);
      // The whole point: it beats the runner's clock, so this result survives.
      expect(r.durationMs).toBeLessThan(probeTimeoutMs());
    } finally {
      delete process.env.SIGNALK_URL;
      delete process.env.SIGNALK_HTTPS_URL;
    }
  });

  it('updater-health fails inside the runner budget, cutting the retry ladder short', async () => {
    fetchSpy.mockImplementation(blackHole());
    const p = probeUpdaterHealth();
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await p;

    expect(r.status).toBe('fail');
    // The endpoint is a module-level const, so assert the shape of the verdict
    // rather than a URL this test cannot influence.
    expect(r.message).toMatch(/^cannot reach http/);
    expect(r.message).toMatch(/timed out/);
    expect(r.durationMs).toBeLessThan(probeTimeoutMs());
    // Fewer than the full 1 + RETRIES attempts: the ladder stops once the
    // budget can no longer fund one. Attempting anyway is what overran.
    expect(fetchSpy.mock.calls.length).toBeLessThan(3);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('updater-health stays inside the budget when headers arrive but the body stalls', async () => {
    // The half-open case the headers-only timeout missed: the updater answers
    // 200 and then never finishes the body. Clearing the abort timer once
    // headers land left `res.json()` unbounded, so the probe ran forever and
    // the runner threw its verdict away — the same `unknown` this whole change
    // exists to stop. The timeout must span the body read too.
    fetchSpy.mockImplementation((_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            (init as RequestInit | undefined)?.signal?.addEventListener('abort', () => {
              const err = new Error('This operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      } as unknown as Response),
    );

    const p = probeUpdaterHealth();
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await p;

    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/^cannot reach http/);
    expect(r.message).toMatch(/timed out/);
    expect(r.durationMs).toBeLessThan(probeTimeoutMs());
  });
});

describe('startProbeDeadline', () => {
  const prev = process.env.PROBE_TIMEOUT_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.PROBE_TIMEOUT_MS;
    else process.env.PROBE_TIMEOUT_MS = prev;
  });

  it('leaves headroom under the runner ceiling so the probe wins the race', () => {
    delete process.env.PROBE_TIMEOUT_MS;
    const d = startProbeDeadline();
    expect(d.remaining()).toBeLessThan(probeTimeoutMs());
    expect(d.remaining()).toBeGreaterThan(probeTimeoutMs() / 2);
  });

  it('clamps a hop to what is left rather than granting the full ask', () => {
    process.env.PROBE_TIMEOUT_MS = '2000';
    const d = startProbeDeadline();
    expect(d.hop(5000)).toBe(d.remaining());
    expect(d.hop(100)).toBe(100);
  });

  it('stays inside even a tiny env-shrunk ceiling', () => {
    process.env.PROBE_TIMEOUT_MS = '250';
    const d = startProbeDeadline();
    expect(d.remaining()).toBeLessThan(250);
    expect(d.remaining()).toBeGreaterThan(0);
    // Too small for a meaningful hop, so a multi-hop probe skips the extra one
    // instead of manufacturing a timeout that looks like unreachability.
    expect(d.allows(MIN_HOP_MS)).toBe(false);
  });
});

describe('describeFetchError', () => {
  it('labels an abort as a timeout and reports how long it waited', () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    expect(describeFetchError(err, 4200)).toBe('no response after 4200ms (timed out)');
  });

  it("surfaces undici's hidden cause code instead of a bare 'fetch failed'", () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    expect(describeFetchError(err, 3)).toBe('fetch failed (ECONNREFUSED)');
  });

  it('digs the code out of a Happy-Eyeballs AggregateError cause', () => {
    // The shape undici produces for a refused localhost connection: the
    // aggregate carries no code of its own, only the per-address errors.
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = new AggregateError(
      [Object.assign(new Error('connect ECONNREFUSED ::1:9'), { code: 'ECONNREFUSED' })],
      'all attempts failed',
    );
    expect(describeFetchError(err, 4)).toBe('fetch failed (ECONNREFUSED)');
  });

  it("falls back to the cause's text when it carries no errno", () => {
    // undici's own refusals (blocked port, bad URL) have a message but no code.
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = new Error('bad port');
    expect(describeFetchError(err, 1)).toBe('fetch failed (bad port)');
  });

  it('passes through an error with no cause at all unchanged', () => {
    expect(describeFetchError(new Error('boom'), 1)).toBe('boom');
  });
});
