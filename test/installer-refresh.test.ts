import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { __resetTokenCacheForTests } from '../src/auth.js';

// Minimal mock of the GitHub Pages payload. The dispatcher template's
// __SK_VERSION__ placeholder is substituted upstream by the installer-repo
// Pages workflow at deploy time, so the body served here mirrors what the
// doctor actually fetches from Pages — version already baked in.
const SIGNALK_TMPL = `#!/usr/bin/env bash
SK_VERSION="1.2.3-test"
echo "signalk $SK_VERSION"
`;

const RECOVERY_TMPL = `#!/usr/bin/env bash
echo "signalk-recovery"
`;

const SOCKETCAN_TMPL = `#!/usr/bin/env bash
echo "signalk-socketcan"
`;

const BLUETOOTH_TMPL = `#!/usr/bin/env bash
echo "signalk-bluetooth"
`;

const QUADLET_TMPL = `[Unit]
Description=Test
[Container]
Image=__DOCTOR_IMAGE__
`;

const DETECT_SCRIPT = `#!/usr/bin/env bash
echo '{"detectedAt":"test"}'
`;

const RENDER_SCRIPT = `#!/usr/bin/env bash
echo "render-server-quadlet"
`;

interface RouteFixture {
  expectedSubstr: string; // sentinel that should appear in fetched body
  body: string;
}

const FIXTURES: Record<string, RouteFixture> = {
  '/installer/linux/signalk.tmpl': { expectedSubstr: 'SK_VERSION=', body: SIGNALK_TMPL },
  '/installer/linux/signalk-recovery.tmpl': {
    expectedSubstr: 'signalk-recovery',
    body: RECOVERY_TMPL,
  },
  '/installer/linux/signalk-socketcan.tmpl': {
    expectedSubstr: 'signalk-socketcan',
    body: SOCKETCAN_TMPL,
  },
  '/installer/linux/signalk-bluetooth.tmpl': {
    expectedSubstr: 'signalk-bluetooth',
    body: BLUETOOTH_TMPL,
  },
  '/installer/linux/detect-hardware.sh': { expectedSubstr: 'detectedAt', body: DETECT_SCRIPT },
  '/installer/linux/render-server-quadlet.sh': {
    expectedSubstr: 'render-server-quadlet',
    body: RENDER_SCRIPT,
  },
  '/quadlets/signalk-server.container.template': {
    expectedSubstr: '__DOCTOR_IMAGE__',
    body: QUADLET_TMPL,
  },
  '/quadlets/signalk-updater-server.container.template': {
    expectedSubstr: '__DOCTOR_IMAGE__',
    body: QUADLET_TMPL,
  },
  '/quadlets/signalk-doctor-server.container.template': {
    expectedSubstr: '__DOCTOR_IMAGE__',
    body: QUADLET_TMPL,
  },
  '/quadlets/signalk-dbus-proxy.container.template': {
    expectedSubstr: '__DOCTOR_IMAGE__',
    body: QUADLET_TMPL,
  },
};

// Start a tiny HTTP server on a random port to stand in for GitHub Pages.
// Done this way (rather than mocking fetch globally) so we exercise the
// real Node fetch + Buffer plumbing in refresh.ts.
async function startFakePages(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const fixture = FIXTURES[url];
    if (!fixture) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'text/plain');
    res.end(fixture.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('failed to bind fake pages server');
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('installer-refresh routes', () => {
  let dir: string;
  let hostBin: string;
  let pages: Awaited<ReturnType<typeof startFakePages>>;
  const prevDoctorData = process.env.DOCTOR_DATA;
  const prevTokenPath = process.env.TOKEN_PATH;
  const prevHostBin = process.env.HOST_BIN_DIR;
  const prevPagesBase = process.env.INSTALLER_PAGES_BASE;
  const prevLockDir = process.env.LOCK_DIR;
  const prevLockPath = process.env.OPERATION_LOCK;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'installer-refresh-'));
    hostBin = join(dir, 'host-bin');
    await mkdir(hostBin, { recursive: true });

    process.env.DOCTOR_DATA = dir;
    process.env.HOST_BIN_DIR = hostBin;
    const tokenPath = join(dir, 'token');
    await writeFile(tokenPath, 'sekret\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(tokenPath, 0o600);
    process.env.TOKEN_PATH = tokenPath;
    __resetTokenCacheForTests();

    // withMutex writes a file under LOCK_DIR; default /updater-data isn't
    // writable in tests. mutex.ts caches LOCK_PATH at import time, so
    // setting LOCK_DIR after import has no effect — the OPERATION_LOCK
    // override is read at module-load too, but it lets us point directly
    // at our tmp dir as long as it's set before the first import. Vitest
    // runs each test file in a fresh worker, so this works.
    process.env.LOCK_DIR = dir;
    process.env.OPERATION_LOCK = join(dir, 'operation.lock');

    pages = await startFakePages();
    process.env.INSTALLER_PAGES_BASE = pages.baseUrl;
  });

  afterAll(async () => {
    if (prevDoctorData === undefined) delete process.env.DOCTOR_DATA;
    else process.env.DOCTOR_DATA = prevDoctorData;
    if (prevTokenPath === undefined) delete process.env.TOKEN_PATH;
    else process.env.TOKEN_PATH = prevTokenPath;
    if (prevHostBin === undefined) delete process.env.HOST_BIN_DIR;
    else process.env.HOST_BIN_DIR = prevHostBin;
    if (prevPagesBase === undefined) delete process.env.INSTALLER_PAGES_BASE;
    else process.env.INSTALLER_PAGES_BASE = prevPagesBase;
    if (prevLockDir === undefined) delete process.env.LOCK_DIR;
    else process.env.LOCK_DIR = prevLockDir;

    await pages.close();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Reset host-bin + payload between tests so each test starts from a
    // clean slate without affecting tests that assert "unchanged" status.
    await rm(hostBin, { recursive: true, force: true });
    await mkdir(hostBin, { recursive: true });
    await rm(join(dir, 'installer-payload'), { recursive: true, force: true });
    await rm(join(dir, 'installer-snapshots'), { recursive: true, force: true });
  });

  it('GET /api/installer/status returns artifact inventory without a token', async () => {
    const { app } = await createServer();
    const res = await app.inject({ method: 'GET', url: '/api/installer/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hostBinMounted).toBe(true);
    expect(body.pagesBase).toBe(pages.baseUrl);
    expect(body.artifacts).toHaveLength(10);
    expect(body.artifacts.every((a: { present: boolean }) => a.present === false)).toBe(true);
    await app.close();
  });

  it('POST /api/installer/refresh without token returns 401', async () => {
    const { app } = await createServer();
    const res = await app.inject({ method: 'POST', url: '/api/installer/refresh' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('POST /api/installer/refresh writes all artifacts byte-for-byte from Pages', async () => {
    const { app } = await createServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/installer/refresh',
      headers: { authorization: 'Bearer sekret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts.updated).toBe(10);
    expect(body.counts['fetch-failed']).toBe(0);
    expect(body.counts['mount-missing']).toBe(0);

    // signalk template is written byte-for-byte; the version was already
    // baked in upstream by the Pages deploy workflow.
    const signalkBody = await readFile(join(hostBin, 'signalk'), 'utf8');
    expect(signalkBody).toBe(SIGNALK_TMPL);
    expect(signalkBody).not.toContain('__SK_VERSION__');

    // recovery is byte-for-byte identical (no substitution).
    const recoveryBody = await readFile(join(hostBin, 'signalk-recovery'), 'utf8');
    expect(recoveryBody).toBe(RECOVERY_TMPL);

    // socketcan helper is byte-for-byte identical (no substitution).
    const socketcanBody = await readFile(join(hostBin, 'signalk-socketcan'), 'utf8');
    expect(socketcanBody).toBe(SOCKETCAN_TMPL);

    // bluetooth helper follows the same no-substitution contract.
    const bluetoothBody = await readFile(join(hostBin, 'signalk-bluetooth'), 'utf8');
    expect(bluetoothBody).toBe(BLUETOOTH_TMPL);

    // Quadlet templates are NOT substituted by the doctor; they're written
    // verbatim into the payload dir for the bash installer's render step.
    const quadletBody = await readFile(
      join(dir, 'installer-payload', 'signalk-server.container.template'),
      'utf8',
    );
    expect(quadletBody).toContain('__DOCTOR_IMAGE__');

    await app.close();
  });

  it('second refresh in a row reports unchanged and creates no new snapshot', async () => {
    const { app } = await createServer();
    // First refresh — establishes the baseline.
    await app.inject({
      method: 'POST',
      url: '/api/installer/refresh',
      headers: { authorization: 'Bearer sekret' },
    });
    const firstSnapshots = (await readdir(join(dir, 'installer-snapshots')).catch(
      () => [],
    )) as string[];

    // Second refresh — bytes match, so each artifact should be "unchanged"
    // and no new snapshots should land.
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/installer/refresh',
      headers: { authorization: 'Bearer sekret' },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.counts.unchanged).toBe(10);
    expect(body2.counts.updated).toBe(0);

    const secondSnapshots = await readdir(join(dir, 'installer-snapshots')).catch(
      () => [] as string[],
    );
    expect(secondSnapshots.length).toBe(firstSnapshots.length);

    await app.close();
  });

  it('snapshots the prior content of changed files', async () => {
    const { app } = await createServer();
    // Plant an old version of the dispatcher so the refresh has something
    // to snapshot before overwriting.
    await writeFile(join(hostBin, 'signalk'), '#!/usr/bin/env bash\necho old\n', { mode: 0o755 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/installer/refresh',
      headers: { authorization: 'Bearer sekret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const signalkResult = body.results.find((r: { id: string }) => r.id === 'signalk');
    expect(signalkResult.status).toBe('updated');
    expect(signalkResult.snapshotPath).toMatch(/installer-snapshots\/.*-signalk$/);

    const snapBody = await readFile(signalkResult.snapshotPath, 'utf8');
    expect(snapBody).toBe('#!/usr/bin/env bash\necho old\n');
    await app.close();
  });

  it('reports mount-missing for host-script artifacts when HOST_BIN_DIR is absent', async () => {
    // Point HOST_BIN_DIR at a path that doesn't exist. Quadlet templates
    // and detect-hardware (under PAYLOAD_DIR) should still succeed.
    const prevHost = process.env.HOST_BIN_DIR;
    process.env.HOST_BIN_DIR = join(dir, 'no-such-mount');
    try {
      const { app } = await createServer();
      const res = await app.inject({
        method: 'POST',
        url: '/api/installer/refresh',
        headers: { authorization: 'Bearer sekret' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.counts['mount-missing']).toBe(4); // signalk + recovery + socketcan + bluetooth
      expect(body.counts.updated).toBe(6); // detect + render-server-quadlet + 4 quadlets
      await app.close();
    } finally {
      if (prevHost === undefined) delete process.env.HOST_BIN_DIR;
      else process.env.HOST_BIN_DIR = prevHost;
    }
  });
});
