import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeWatchdog } from '../src/probes/watchdog.js';

describe('hardware-watchdog probe', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'watchdog-probe-'));
    prev = process.env.HOST_SYS;
    process.env.HOST_SYS = join(dir, 'sys');
  });

  afterEach(async () => {
    if (prev === undefined) delete process.env.HOST_SYS;
    else process.env.HOST_SYS = prev;
    await rm(dir, { recursive: true, force: true });
  });

  // A fake /host/sys/class/watchdog/watchdog0 with the three attributes the
  // probe reads, each newline-terminated like sysfs.
  async function fakeWatchdog(attrs: { identity: string; state: string; timeout: string }) {
    const wd = join(dir, 'sys/class/watchdog/watchdog0');
    await mkdir(wd, { recursive: true });
    for (const [k, v] of Object.entries(attrs)) await writeFile(join(wd, k), `${v}\n`);
  }

  it("is 'unknown' when the host /sys mount is missing", async () => {
    const r = await probeWatchdog();
    expect(r.id).toBe('hardware-watchdog');
    expect(r.status).toBe('unknown');
    expect(r.message).toMatch(/host \/sys mount/);
  });

  it("is 'ok' on a host without a watchdog device", async () => {
    await mkdir(join(dir, 'sys/class'), { recursive: true });
    const r = await probeWatchdog();
    expect(r.status).toBe('ok');
    expect(r.message).toBe('No hardware watchdog on this host');
  });

  it("is 'ok' with the timeout when the watchdog is armed", async () => {
    await fakeWatchdog({
      identity: 'Broadcom BCM2835 Watchdog timer',
      state: 'active',
      timeout: '15',
    });
    const r = await probeWatchdog();
    expect(r.status).toBe('ok');
    expect(r.message).toBe(
      'Armed: the host resets after 15 s without a ping (Broadcom BCM2835 Watchdog timer)',
    );
    expect(r.details).toEqual({
      identity: 'Broadcom BCM2835 Watchdog timer',
      state: 'active',
      timeoutSec: 15,
    });
  });

  it("warns when a Raspberry Pi's watchdog is not armed", async () => {
    await fakeWatchdog({
      identity: 'Broadcom BCM2835 Watchdog timer',
      state: 'inactive',
      timeout: '15',
    });
    const r = await probeWatchdog();
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/not armed/);
    expect(r.message).toMatch(/SIGNALK_NO_WATCHDOG=1/);
  });

  it("is 'ok' for an unarmed watchdog on another board, which the installer leaves alone", async () => {
    await fakeWatchdog({ identity: 'iTCO_wdt', state: 'inactive', timeout: '30' });
    const r = await probeWatchdog();
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/Present \(iTCO_wdt\) but not armed/);
  });

  it("is 'unknown' when the state attribute cannot be read", async () => {
    await mkdir(join(dir, 'sys/class/watchdog/watchdog0'), { recursive: true });
    const r = await probeWatchdog();
    expect(r.status).toBe('unknown');
    expect(r.message).toMatch(/Cannot read .*\/state/);
  });
});
