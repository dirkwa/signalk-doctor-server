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

  it('reports a JSON-null health payload as reachable, not as unreachable', async () => {
    // `null` is valid JSON. Dereferencing it threw a TypeError that the
    // transport catch swallowed, so a 200-answering updater was reported as
    // `cannot reach` — the route blamed for a fault in the reply.
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: null,
        json: () => Promise.resolve(null),
      } as unknown as Response),
    );

    const r = await probeUpdaterHealth();

    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/reachable/);
    expect(r.message).not.toMatch(/cannot reach/);
  });

  it('cancels a non-2xx body instead of leaving the connection held', async () => {
    // An unconsumed undici stream keeps its connection out of the pool; at
    // three attempts per run on every /api/probes call that starves the
    // probes that follow.
    const cancel = vi.fn().mockResolvedValue(undefined);
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        body: { cancel },
        json: () => Promise.reject(new Error('body must not be read')),
      } as unknown as Response),
    );

    const r = await probeUpdaterHealth();

    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/HTTP 503/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not call a string "false" healthy', async () => {
    // `{ ok: "false" }` is truthy, so a non-null check alone sent an updater
    // that had just declared itself unhealthy down the healthy branch and
    // printed "Updater reports OK" — the engine stating the opposite of what
    // the service said.
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: null,
        json: () => Promise.resolve({ ok: 'false', runtime: 'podman' }),
      } as unknown as Response),
    );

    const r = await probeUpdaterHealth();

    expect(r.status).not.toBe('ok');
    expect(r.message).not.toMatch(/reports OK/);
    expect(r.message).toMatch(/reachable/);
  });

  it('treats malformed JSON as reachable-but-unreadable, not unreachable', async () => {
    // The same misdiagnosis as the null payload, reached by another route:
    // res.json() rejecting fell into the transport catch and reported
    // `cannot reach` for an updater that answered 200.
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: null,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      } as unknown as Response),
    );

    const r = await probeUpdaterHealth();

    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/reachable/);
    expect(r.message).not.toMatch(/cannot reach/);
  });

  it('does not start a hop when the retry delay overran the budget', async () => {
    // The bottom-of-loop guard leaves exactly MIN_HOP_MS in the best case, and
    // setTimeout is a floor, not a ceiling. On a contended box — the case this
    // probe diagnoses — the delay resumes late and that margin is gone. The
    // fetch would then run on a near-zero budget, abort instantly, and replace
    // the real connection error with a synthetic timeout.
    let calls = 0;
    fetchSpy.mockImplementation(() => {
      calls++;
      return Promise.reject(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
      );
    });

    const p = probeUpdaterHealth();
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await p;

    // The refusal is fast, so the ladder gets its attempts; what must survive
    // is the actionable errno, not a timeout manufactured on an empty budget.
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/ECONNREFUSED/);
    expect(r.message).not.toMatch(/timed out/);
    expect(calls).toBeGreaterThan(0);
    expect(r.durationMs).toBeLessThan(probeTimeoutMs());
  });

  it('still reports an abort during the body read as a timeout', async () => {
    // The parse-error catch must not swallow the deadline firing mid-body:
    // that is a timeout, and mislabelling it "unreadable" would throw away
    // the diagnosis this whole budget exists to produce.
    fetchSpy.mockImplementation((_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: null,
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
    // Read the budget first: hop() and remaining() sample the clock at
    // different instants, so asserting they are equal fails whenever a
    // millisecond lands between them even though the clamp is correct.
    const before = d.remaining();
    expect(d.hop(5000)).toBeLessThanOrEqual(before);
    expect(d.hop(5000)).toBeGreaterThan(0);
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
