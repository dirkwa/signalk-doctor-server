import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  probeClockGps,
  parseHostState,
  readGpsTime,
  readPluginEnabled,
  type ClockGpsSources,
  type HostTimeState,
} from '../src/probes/clock-gps.js';
import { startProbeDeadline } from '../src/probes/budget.js';

const NOW = Date.parse('2026-11-16T20:00:00Z');

function iso(offsetS: number): string {
  return new Date(NOW + offsetS * 1000).toISOString();
}

const healthyHost: HostTimeState = {
  ok: true,
  timerLoaded: true,
  timerActive: true,
  ntpSynchronized: false,
};

function sources(over: Partial<ClockGpsSources> = {}): ClockGpsSources {
  return {
    now: NOW,
    gps: { ok: true, value: iso(2), timestamp: iso(-1) },
    pluginEnabled: false,
    host: healthyHost,
    wsl: false,
    ...over,
  };
}

const run = (s: ClockGpsSources) => probeClockGps({ gatherSources: async () => s });

describe('probeClockGps', () => {
  it('emits the registered id/label', async () => {
    const r = await run(sources());
    expect(r.id).toBe('clock-gps');
    expect(r.label).toBe('System clock vs GPS');
  });

  it('ok when the clock is within the window of fresh GPS time', async () => {
    const r = await run(sources());
    expect(r.status).toBe('ok');
    expect(r.message).toBe('clock within 2 s of GPS');
    expect(r.details?.offsetSec).toBe(2);
  });

  it('warns when the clock is off and the timer is on without NTP', async () => {
    const r = await run(sources({ gps: { ok: true, value: iso(3600), timestamp: iso(0) } }));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('clock is 60 min behind GPS');
    expect(r.message).toContain('signalk-timesync is on and there is no NTP');
  });

  it('names the switched-off timer as the cause of an offset', async () => {
    const r = await run(
      sources({
        gps: { ok: true, value: iso(-600), timestamp: iso(0) },
        host: { ...healthyHost, timerActive: false },
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('clock is 10 min ahead of GPS');
    expect(r.message).toContain('timer is off');
    expect(r.message).toContain('re-run the installer');
  });

  it('warns about a switched-off timer even while the clock is right', async () => {
    const r = await run(sources({ host: { ...healthyHost, timerActive: false } }));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('timer is off');
    expect(r.message).toContain('clock within 2 s of GPS');
  });

  it('warns when the agent is not installed', async () => {
    const r = await run(
      sources({ host: { ...healthyHost, timerLoaded: false, timerActive: false } }),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('signalk-timesync is not installed');
  });

  it('points at the GPS source when NTP disagrees with GPS', async () => {
    const r = await run(
      sources({
        gps: { ok: true, value: iso(120), timestamp: iso(0) },
        host: { ...healthyHost, ntpSynchronized: true },
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('while NTP is synchronised');
  });

  it('warns that an enabled set-system-time plugin is not needed', async () => {
    const r = await run(sources({ pluginEnabled: true }));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('set-system-time plugin is enabled');
    expect(r.message).toContain('disable the plugin');
  });

  it('warns when the Signal K token is missing', async () => {
    const r = await run(
      sources({
        gps: { ok: false, reason: 'no-token', detail: 'no Signal K token at /data/signalk-token' },
        pluginEnabled: null,
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('signalk-timesync cannot read GPS time either');
  });

  it('unknown without GPS time when nothing else is wrong', async () => {
    const r = await run(
      sources({
        gps: { ok: false, reason: 'no-data', detail: 'Signal K has no navigation.datetime' },
      }),
    );
    expect(r.status).toBe('unknown');
    expect(r.message).toContain('no navigation.datetime');
  });

  it('does not compare stale GPS time', async () => {
    const r = await run(sources({ gps: { ok: true, value: iso(3600), timestamp: iso(-300) } }));
    expect(r.status).toBe('unknown');
    expect(r.message).toContain('5 min old');
  });

  it('points at the Windows clock under WSL and skips the timer checks', async () => {
    const r = await run(
      sources({
        wsl: true,
        gps: { ok: true, value: iso(300), timestamp: iso(0) },
        host: { ...healthyHost, timerLoaded: false, timerActive: false },
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('Windows clock');
    expect(r.message).not.toContain('signalk-timesync');
  });

  it('reports an offset it cannot explain when the host state is unreadable', async () => {
    const r = await run(
      sources({
        gps: { ok: true, value: iso(90), timestamp: iso(0) },
        host: { ok: false, detail: 'timeout: host command did not finish' },
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('cannot read the time sync state');
  });
});

describe('parseHostState', () => {
  it('reads systemctl show and timedatectl output', () => {
    expect(parseHostState('LoadState=loaded\nActiveState=active\nNTPSynchronized=no\n')).toEqual({
      ok: true,
      timerLoaded: true,
      timerActive: true,
      ntpSynchronized: false,
    });
  });

  it('treats a missing unit as not loaded', () => {
    const s = parseHostState('LoadState=not-found\nActiveState=inactive\nNTPSynchronized=yes\n');
    expect(s).toEqual({ ok: true, timerLoaded: false, timerActive: false, ntpSynchronized: true });
  });

  it('fails on output without the expected keys', () => {
    expect(parseHostState('garbage').ok).toBe(false);
  });
});

describe('reading Signal K', () => {
  const HTTP = 'http://sk.test:80/signalk';
  const HTTPS = 'https://sk.test:443/signalk';
  const prevHttp = process.env.SIGNALK_URL;
  const prevHttps = process.env.SIGNALK_HTTPS_URL;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function res(status: number, body?: unknown, type = 'basic'): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      type,
      json: async () => body,
    } as Response;
  }

  beforeEach(() => {
    process.env.SIGNALK_URL = HTTP;
    process.env.SIGNALK_HTTPS_URL = HTTPS;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (prevHttp === undefined) delete process.env.SIGNALK_URL;
    else process.env.SIGNALK_URL = prevHttp;
    if (prevHttps === undefined) delete process.env.SIGNALK_HTTPS_URL;
    else process.env.SIGNALK_HTTPS_URL = prevHttps;
  });

  it('reads navigation.datetime with the token, following the SSL redirect', async () => {
    fetchSpy
      .mockResolvedValueOnce(res(0, undefined, 'opaqueredirect'))
      .mockResolvedValueOnce(res(200, { value: iso(0), timestamp: iso(0) }));
    const gps = await readGpsTime('tok', startProbeDeadline());
    expect(gps).toEqual({ ok: true, value: iso(0), timestamp: iso(0) });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'http://sk.test:80/signalk/v1/api/vessels/self/navigation/datetime',
    );
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      'https://sk.test:443/signalk/v1/api/vessels/self/navigation/datetime',
    );
    const init = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(init.headers).toEqual({ authorization: 'Bearer tok' });
  });

  it('reports no data for a 404', async () => {
    fetchSpy.mockResolvedValueOnce(res(404));
    const gps = await readGpsTime('tok', startProbeDeadline());
    expect(gps).toMatchObject({ ok: false, reason: 'no-data' });
  });

  it('makes no request without a token', async () => {
    const gps = await readGpsTime(null, startProbeDeadline());
    expect(gps).toMatchObject({ ok: false, reason: 'no-token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads whether set-system-time is enabled from its config', async () => {
    fetchSpy.mockResolvedValueOnce(res(200, { enabled: true, configuration: {} }));
    expect(await readPluginEnabled('tok', startProbeDeadline())).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://sk.test:80/plugins/set-system-time/config');
    fetchSpy.mockResolvedValueOnce(res(404));
    expect(await readPluginEnabled('tok', startProbeDeadline())).toBe(false);
  });
});
