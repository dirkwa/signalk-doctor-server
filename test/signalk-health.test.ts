import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeSignalkHealth } from '../src/probes/signalk-health.js';
import { signalkHttpUrl, signalkHttpsUrl } from '../src/probes/signalk-url.js';

const HTTP = 'http://sk.test:80/signalk';
const HTTPS = 'https://sk.test:443/signalk';

// Build a Response-like stub. `opaqueredirect` mimics what
// `redirect: 'manual'` yields for a 3xx (status 0, type opaqueredirect).
function res(init: { status?: number; ok?: boolean; type?: string }): Response {
  const status = init.status ?? 200;
  return {
    status,
    ok: init.ok ?? (status >= 200 && status < 300),
    type: init.type ?? 'basic',
  } as Response;
}

const refused = () => Promise.reject(new Error('fetch failed'));

describe('signalk-url defaults', () => {
  const prevHttp = process.env.SIGNALK_URL;
  const prevHttps = process.env.SIGNALK_HTTPS_URL;
  afterEach(() => {
    if (prevHttp === undefined) delete process.env.SIGNALK_URL;
    else process.env.SIGNALK_URL = prevHttp;
    if (prevHttps === undefined) delete process.env.SIGNALK_HTTPS_URL;
    else process.env.SIGNALK_HTTPS_URL = prevHttps;
  });

  it('defaults HTTP to the host-gateway on port 80', () => {
    delete process.env.SIGNALK_URL;
    expect(signalkHttpUrl()).toBe('http://host.containers.internal:80/signalk');
  });

  it('returns null HTTPS when unset (no fallback attempted)', () => {
    delete process.env.SIGNALK_HTTPS_URL;
    expect(signalkHttpsUrl()).toBeNull();
  });

  it('honours the injected env URLs', () => {
    process.env.SIGNALK_URL = HTTP;
    process.env.SIGNALK_HTTPS_URL = HTTPS;
    expect(signalkHttpUrl()).toBe(HTTP);
    expect(signalkHttpsUrl()).toBe(HTTPS);
  });
});

describe('probeSignalkHealth', () => {
  const prevHttp = process.env.SIGNALK_URL;
  const prevHttps = process.env.SIGNALK_HTTPS_URL;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

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

  it('reports ok and does not touch HTTPS when HTTP answers 200', async () => {
    fetchSpy.mockResolvedValueOnce(res({ status: 200 }));
    const r = await probeSignalkHealth();
    expect(r.id).toBe('signalk-health');
    expect(r.status).toBe('ok');
    expect(r.message).toContain(HTTP);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The HTTP probe must not auto-follow the redirect into TLS.
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(HTTP);
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit)?.redirect).toBe('manual');
  });

  it('follows a 302 to HTTPS and reports ok with an SSL note', async () => {
    fetchSpy
      .mockResolvedValueOnce(res({ status: 302, ok: false, type: 'opaqueredirect' }))
      .mockResolvedValueOnce(res({ status: 200 }));
    const r = await probeSignalkHealth();
    expect(r.status).toBe('ok');
    expect(r.message).toContain(HTTPS);
    expect(r.message).toMatch(/SSL enabled/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(HTTPS);
  });

  it('fails when HTTP redirects to HTTPS but no HTTPS URL is configured', async () => {
    delete process.env.SIGNALK_HTTPS_URL;
    fetchSpy.mockResolvedValueOnce(res({ status: 302, ok: false, type: 'opaqueredirect' }));
    const r = await probeSignalkHealth();
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/SIGNALK_HTTPS_URL/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to HTTPS when the HTTP listener refuses, reports ok', async () => {
    fetchSpy.mockImplementationOnce(refused).mockResolvedValueOnce(res({ status: 200 }));
    const r = await probeSignalkHealth();
    expect(r.status).toBe('ok');
    expect(r.message).toContain(HTTPS);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('fails and names both URLs when HTTP and HTTPS are both unreachable', async () => {
    fetchSpy.mockImplementationOnce(refused).mockImplementationOnce(refused);
    const r = await probeSignalkHealth();
    expect(r.status).toBe('fail');
    expect(r.message).toContain(HTTP);
    expect(r.message).toContain(HTTPS);
  });

  it('fails on an HTTP 5xx without falling back to HTTPS', async () => {
    fetchSpy.mockResolvedValueOnce(res({ status: 503, ok: false }));
    const r = await probeSignalkHealth();
    expect(r.status).toBe('fail');
    expect(r.message).toContain('503');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
