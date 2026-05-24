import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getLatestVersion } from '../src/drift/npm-registry.js';

describe('getLatestVersion', () => {
  const prevRegistry = process.env.NPM_REGISTRY;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.NPM_REGISTRY = 'https://registry.example';
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    if (prevRegistry === undefined) delete process.env.NPM_REGISTRY;
    else process.env.NPM_REGISTRY = prevRegistry;
    fetchSpy.mockRestore();
  });

  it('returns fetched result when registry responds 200 with version', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '3.19.0' }), {
        status: 200,
        headers: { etag: 'W/"abc"' },
      }),
    );
    const result = await getLatestVersion('@canboat/canboatjs', null);
    expect(result).toEqual({ kind: 'fetched', version: '3.19.0', etag: 'W/"abc"' });
  });

  it('sends If-None-Match header when previous etag is supplied', async () => {
    // undici's Response constructor rejects status 304 (null-body status),
    // so duck-type the parts the implementation actually reads.
    const notModified = {
      status: 304,
      ok: false,
      headers: { get: (): string | null => null },
      json: async (): Promise<unknown> => ({}),
    } as unknown as Response;
    fetchSpy.mockResolvedValueOnce(notModified);
    const result = await getLatestVersion('foo', 'W/"prev-etag"');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('expected one fetch call');
    const init = call[1] as { headers: Record<string, string> };
    expect(init.headers['If-None-Match']).toBe('W/"prev-etag"');
    expect(result.kind).toBe('not-modified');
  });

  it('encodes scoped package names without double-encoding the @', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 }),
    );
    await getLatestVersion('@scope/pkg', null);
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('expected one fetch call');
    const url = String(call[0]);
    expect(url).toContain('/@scope%2Fpkg/latest');
  });

  it('classifies network failure as offline', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    const result = await getLatestVersion('foo', null);
    expect(result.kind).toBe('offline');
  });

  it('classifies non-2xx as error', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));
    const result = await getLatestVersion('foo', null);
    expect(result.kind).toBe('error');
  });
});
