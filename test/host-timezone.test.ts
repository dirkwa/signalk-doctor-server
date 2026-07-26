import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostTimezone, isValidZone } from '../src/host-timezone.js';

// Same strategy as bug-report.test.ts: stand up a fake `systemd-run` on PATH
// so we exercise the real spawn/timeout/exit handling without needing a host
// bus. The fake script's behavior is driven per-case.

describe('isValidZone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidZone('Europe/Berlin')).toBe(true);
    expect(isValidZone('America/New_York')).toBe(true);
    expect(isValidZone('UTC')).toBe(true);
  });

  it('rejects strings that pass the regex but are not real zones', () => {
    // These clear the lexical guard but Intl throws RangeError on them.
    expect(isValidZone('Not/AZone')).toBe(false);
    expect(isValidZone('foo')).toBe(false);
  });

  it('rejects lexically invalid strings', () => {
    expect(isValidZone('')).toBe(false);
    expect(isValidZone('Europe/Berlin; rm -rf')).toBe(false);
    expect(isValidZone('a'.repeat(65))).toBe(false);
  });
});

describe('readHostTimezone', () => {
  let pathDir: string;
  let origPath: string | undefined;
  let origTimeout: string | undefined;

  async function fakeSystemdRun(body: string): Promise<void> {
    const script = join(pathDir, 'systemd-run');
    await writeFile(script, `#!/usr/bin/env bash\n${body}\n`);
    await chmod(script, 0o755);
  }

  beforeEach(async () => {
    pathDir = await mkdtemp(join(tmpdir(), 'host-tz-'));
    origPath = process.env.PATH;
    origTimeout = process.env.HOST_TZ_TIMEOUT_MS;
    process.env.PATH = `${pathDir}:${process.env.PATH ?? ''}`;
  });

  afterEach(async () => {
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    if (origTimeout === undefined) delete process.env.HOST_TZ_TIMEOUT_MS;
    else process.env.HOST_TZ_TIMEOUT_MS = origTimeout;
    await rm(pathDir, { recursive: true, force: true });
  });

  it('returns the zone on a clean run', async () => {
    await fakeSystemdRun('echo "Europe/Berlin"');
    const r = await readHostTimezone();
    expect(r).toEqual({ ok: true, zone: 'Europe/Berlin' });
  });

  it('rejects an invalid zone from the host as empty', async () => {
    await fakeSystemdRun('echo "Not/AZone"');
    const r = await readHostTimezone();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  it('categorizes a non-zero exit', async () => {
    await fakeSystemdRun('echo "boom" >&2; exit 3');
    const r = await readHostTimezone();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('nonzero-exit');
      expect(r.detail).toContain('boom');
    }
  });

  it('categorizes a timeout', async () => {
    process.env.HOST_TZ_TIMEOUT_MS = '150';
    await fakeSystemdRun('sleep 5');
    const r = await readHostTimezone();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
  });

  it('reports spawn-failed when systemd-run is not on PATH', async () => {
    // Point PATH at an empty dir so the binary can't be found.
    process.env.PATH = pathDir; // no systemd-run written this case
    const r = await readHostTimezone();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('spawn-failed');
  });
});
