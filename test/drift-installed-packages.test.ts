import { describe, it, expect } from 'vitest';
import { readInstalledPackages, type ContainerProbe } from '../src/drift/installed-packages.js';
import type { CategorizedError } from '../src/errors.js';

// Build a single-entry uncompressed (ustar) tar carrying `body` as the file
// content — exactly the shape dockerode's getArchive returns for one file.
// We only need the size field (offset 124, 12 bytes octal) and the payload;
// the reader doesn't validate the checksum or name, so we leave them minimal.
function ustarTar(body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const header = Buffer.alloc(512, 0);
  header.write('package.json', 0, 'ascii'); // name (offset 0)
  header.write('000644 \0', 100, 'ascii'); // mode
  // size: 11 octal digits + NUL at offset 124
  const sizeOctal = payload.length.toString(8).padStart(11, '0');
  header.write(`${sizeOctal}\0`, 124, 'ascii');
  header.write('ustar\0', 257, 'ascii'); // magic (offset 257)
  header.write('00', 263, 'ascii'); // version
  // tar pads file data to a 512-byte boundary.
  const padLen = (512 - (payload.length % 512)) % 512;
  return Buffer.concat([header, payload, Buffer.alloc(padLen, 0)]);
}

const NOT_FOUND: CategorizedError = {
  kind: 'not-found',
  userMessage: 'Resource not found.',
  raw: '(HTTP code 404) no such container - no such file or directory ',
};

// A probe whose container is present (probe() succeeds) and whose fetch is
// backed by an exact path → tar-body map. Any path not in the map resolves
// to a not-found error (the normal ancestor-walk miss).
function mapProbe(byPath: Record<string, string>): ContainerProbe {
  return {
    probe: () => Promise.resolve({ ok: true, value: Buffer.alloc(0) }),
    fetch: (path) => {
      const body = byPath[path];
      if (body === undefined) return Promise.resolve({ ok: false, error: NOT_FOUND });
      return Promise.resolve({ ok: true, value: ustarTar(body) });
    },
  };
}

const DATA = '/home/node/.signalk';
const APP = '/home/node/signalk';
const NESTED = `${APP}/node_modules/signalk-server`;

function pkgJson(name: string, version: string): string {
  return JSON.stringify({ name, version });
}

describe('readInstalledPackages', () => {
  it('reads all tracked packages from the verified dirkwa layout', async () => {
    // @canboat hoisted to the app root; @signalk nested under signalk-server.
    const byPath: Record<string, string> = {
      [`${APP}/node_modules/@canboat/canboatjs/package.json`]: pkgJson(
        '@canboat/canboatjs',
        '3.20.0',
      ),
      [`${APP}/node_modules/@canboat/ts-pgns/package.json`]: pkgJson('@canboat/ts-pgns', '1.0.0'),
      [`${NESTED}/node_modules/@signalk/n2k-signalk/package.json`]: pkgJson(
        '@signalk/n2k-signalk',
        '4.5.0',
      ),
      [`${NESTED}/node_modules/@signalk/nmea0183-signalk/package.json`]: pkgJson(
        '@signalk/nmea0183-signalk',
        '4.0.0',
      ),
      [`${NESTED}/node_modules/@signalk/path-metadata/package.json`]: pkgJson(
        '@signalk/path-metadata',
        '1.0.0',
      ),
      [`${NESTED}/node_modules/@signalk/server-admin-ui/package.json`]: pkgJson(
        '@signalk/server-admin-ui',
        '2.0.0',
      ),
      [`${NESTED}/node_modules/@signalk/server-api/package.json`]: pkgJson(
        '@signalk/server-api',
        '2.25.0',
      ),
      [`${NESTED}/node_modules/@signalk/streams/package.json`]: pkgJson(
        '@signalk/streams',
        '6.6.0',
      ),
    };
    const res = await readInstalledPackages(mapProbe(byPath));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const imageVersions = Object.fromEntries(res.installed.packages.map((p) => [p.name, p.image]));
    expect(imageVersions).toEqual({
      '@canboat/canboatjs': '3.20.0',
      '@canboat/ts-pgns': '1.0.0',
      '@signalk/n2k-signalk': '4.5.0',
      '@signalk/nmea0183-signalk': '4.0.0',
      '@signalk/path-metadata': '1.0.0',
      '@signalk/server-admin-ui': '2.0.0',
      '@signalk/server-api': '2.25.0',
      '@signalk/streams': '6.6.0',
    });
    // Nothing lives in the data dir in this layout.
    expect(res.installed.packages.every((p) => p.dataDir === null)).toBe(true);
  });

  it('locks the hoisted-@canboat / nested-@signalk resolution (a flat scan drops 5 of 8)', async () => {
    // Only the deep/correct locations are populated. If the walk regressed to
    // a flat single-dir scan of the app root, @signalk/* (nested) would all
    // miss. This is the guard against that regression.
    const byPath: Record<string, string> = {
      [`${APP}/node_modules/@canboat/canboatjs/package.json`]: pkgJson(
        '@canboat/canboatjs',
        '3.20.0',
      ),
      [`${NESTED}/node_modules/@signalk/server-api/package.json`]: pkgJson(
        '@signalk/server-api',
        '2.25.0',
      ),
    };
    const res = await readInstalledPackages(mapProbe(byPath));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const imageVersions = Object.fromEntries(res.installed.packages.map((p) => [p.name, p.image]));
    expect(imageVersions).toMatchObject({
      '@canboat/canboatjs': '3.20.0', // hoisted
      '@signalk/server-api': '2.25.0', // nested
    });
  });

  it('reports the data-dir and image copies separately (no shadowing)', async () => {
    // The regression guard for the misattribution this split fixes: a copy in
    // the user's plugin tree (~/.signalk/node_modules, npm-installed as a
    // plugin dependency) must NOT shadow the image's copy — a fully current
    // image used to show as drifting because a stale plugin dep won the walk.
    const byPath: Record<string, string> = {
      [`${DATA}/node_modules/@canboat/canboatjs/package.json`]: pkgJson(
        '@canboat/canboatjs',
        '9.9.9',
      ),
      [`${APP}/node_modules/@canboat/canboatjs/package.json`]: pkgJson(
        '@canboat/canboatjs',
        '3.20.0',
      ),
    };
    const res = await readInstalledPackages(mapProbe(byPath));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const canboat = res.installed.packages.find((p) => p.name === '@canboat/canboatjs');
    expect(canboat).toEqual({ name: '@canboat/canboatjs', image: '3.20.0', dataDir: '9.9.9' });
  });

  it('reports a package that exists only in the data dir (image: null)', async () => {
    const byPath: Record<string, string> = {
      [`${DATA}/node_modules/@signalk/server-api/package.json`]: pkgJson(
        '@signalk/server-api',
        '2.24.0',
      ),
    };
    const res = await readInstalledPackages(mapProbe(byPath));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.installed.packages).toEqual([
      { name: '@signalk/server-api', image: null, dataDir: '2.24.0' },
    ]);
  });

  it('omits a package that is missing everywhere (no error)', async () => {
    const byPath: Record<string, string> = {
      [`${APP}/node_modules/@canboat/canboatjs/package.json`]: pkgJson(
        '@canboat/canboatjs',
        '3.20.0',
      ),
    };
    const res = await readInstalledPackages(mapProbe(byPath));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.installed.packages.map((p) => p.name)).toEqual(['@canboat/canboatjs']);
  });

  it('swallows a malformed package.json and keeps walking', async () => {
    const byPath: Record<string, string> = {
      // garbage at the most-specific candidate; reader should not throw.
      [`${NESTED}/node_modules/@signalk/server-api/package.json`]: '{ not valid json',
    };
    const res = await readInstalledPackages(mapProbe(byPath));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // malformed → omitted, but the container was reached (a 200 came back).
    expect(res.installed.packages).toEqual([]);
  });

  it('returns runtime — never ok:[] — when the container is absent', async () => {
    // The regression guard for the real-world trap: a runtime that doesn't
    // have signalk-server answers EVERY getArchive with a "no such container"
    // 404 that looks exactly like a path-miss. Without the upfront probe()
    // this returned ok with an empty packages array (a silent lie). The probe
    // must fail loudly so the scanner keeps the prior packages.
    const absent: ContainerProbe = {
      probe: () => Promise.resolve({ ok: false, error: NOT_FOUND }),
      // fetch should never be reached, but make it a path-404 to prove the
      // verdict comes from probe(), not from walking paths.
      fetch: () => Promise.resolve({ ok: false, error: NOT_FOUND }),
    };
    const res = await readInstalledPackages(absent);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('runtime');
  });

  it('returns runtime when the reachability probe errors', async () => {
    const permErr: CategorizedError = {
      kind: 'permission',
      userMessage: 'Permission denied. Check container socket and mount permissions.',
      raw: 'EACCES',
    };
    const probe: ContainerProbe = {
      probe: () => Promise.resolve({ ok: false, error: permErr }),
      fetch: () => Promise.resolve({ ok: false, error: permErr }),
    };
    const res = await readInstalledPackages(probe);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('runtime');
  });

  it('tolerates a transient per-path error once the container is reachable', async () => {
    // probe() succeeds (container present). @canboat/canboatjs resolves
    // cleanly; @signalk/server-api hits a non-not-found error on its real
    // (nested) location. Because reachability is already proven, the erroring
    // package is omitted and the scan still succeeds with the rest.
    const permErr: CategorizedError = {
      kind: 'permission',
      userMessage: 'Permission denied. Check container socket and mount permissions.',
      raw: 'EACCES',
    };
    const canboatPath = `${APP}/node_modules/@canboat/canboatjs/package.json`;
    const serverApiPath = `${NESTED}/node_modules/@signalk/server-api/package.json`;
    const probe: ContainerProbe = {
      probe: () => Promise.resolve({ ok: true, value: Buffer.alloc(0) }),
      fetch: (path) => {
        if (path === canboatPath) {
          return Promise.resolve({
            ok: true,
            value: ustarTar(pkgJson('@canboat/canboatjs', '3.20.0')),
          });
        }
        if (path === serverApiPath) return Promise.resolve({ ok: false, error: permErr });
        return Promise.resolve({ ok: false, error: NOT_FOUND });
      },
    };
    const res = await readInstalledPackages(probe);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.installed.packages).toEqual([
      { name: '@canboat/canboatjs', image: '3.20.0', dataDir: null },
    ]);
  });

  it('returns runtime — never ok:[] — when the container is reachable but every read errors', async () => {
    // probe() succeeds (container present), but a permission/socket fault makes
    // EVERY getArchive fail with a non-not-found error. The inspect probe can't
    // catch this, so the empty-success guard must: returning ok:[] here would
    // look like a healthy image with no packages and zero the prior data.
    const permErr: CategorizedError = {
      kind: 'permission',
      userMessage: 'Permission denied. Check container socket and mount permissions.',
      raw: 'EACCES',
    };
    const probe: ContainerProbe = {
      probe: () => Promise.resolve({ ok: true, value: Buffer.alloc(0) }),
      fetch: () => Promise.resolve({ ok: false, error: permErr }),
    };
    const res = await readInstalledPackages(probe);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('runtime');
  });

  it('surfaces the stale-podman-namespace remedy for an ns/mnt permission error', async () => {
    // The signature when the rootless podman API service is in a different
    // user namespace than signalk-server: it can't open the container's mount
    // namespace. probe()/inspect still succeeds (metadata only), so this only
    // shows up on the file read. The detail must name the real fix (restart
    // podman.service), NOT the misleading generic "check socket and mount
    // permissions" — the socket is fine.
    const nsErr: CategorizedError = {
      kind: 'permission',
      userMessage: 'Permission denied. Check container socket and mount permissions.',
      raw: '(HTTP code 500) server error - open /proc/3648382/ns/mnt: permission denied',
    };
    const probe: ContainerProbe = {
      probe: () => Promise.resolve({ ok: true, value: Buffer.alloc(0) }),
      fetch: () => Promise.resolve({ ok: false, error: nsErr }),
    };
    const res = await readInstalledPackages(probe);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('runtime');
    expect(res.detail).toMatch(/restart podman\.service/);
    expect(res.detail).toMatch(/stale user namespace/);
    // The generic mount-permissions wording must NOT be what the operator sees.
    expect(res.detail).not.toMatch(/check container socket and mount permissions/i);
  });

  it('surfaces kind + raw for a non-namespace permission error (no false remedy)', async () => {
    // A genuine socket-permission EACCES must NOT claim the namespace remedy.
    const permErr: CategorizedError = {
      kind: 'permission',
      userMessage: 'Permission denied. Check container socket and mount permissions.',
      raw: 'EACCES: permission denied, open /var/run/docker.sock',
    };
    const probe: ContainerProbe = {
      probe: () => Promise.resolve({ ok: true, value: Buffer.alloc(0) }),
      fetch: () => Promise.resolve({ ok: false, error: permErr }),
    };
    const res = await readInstalledPackages(probe);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.detail).not.toMatch(/restart podman\.service/);
    // But the raw IS surfaced so a field report is still conclusive.
    expect(res.detail).toMatch(/docker\.sock/);
  });

  it('returns unreachable when there is no container runtime', async () => {
    // No probe injected and (on CI runners) no podman socket → resolveRuntime
    // returns null. On a dev host with a socket this would instead reach the
    // real runtime, so we only assert the shape, and that the no-runtime path
    // yields a failure reason when it fires.
    const res = await readInstalledPackages();
    if (!res.ok) {
      expect(['unreachable', 'runtime']).toContain(res.reason);
    }
  });
});
