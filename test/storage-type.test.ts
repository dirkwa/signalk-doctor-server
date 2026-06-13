import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRootDevice, decodeDev } from '../src/probes/storage-type.js';

const ENV_SYS = 'HOST_SYS';
const ENV_CGROUP = 'HOST_CGROUP_ROOT';

describe('decodeDev', () => {
  it('decodes the glibc-encoded device number into major:minor', () => {
    // 0x802 = sda2 (8:2); 0xb302 = mmcblk0p2 (179:2).
    expect(decodeDev(0x802)).toEqual({ maj: 8, min: 2 });
    expect(decodeDev(0xb302)).toEqual({ maj: 179, min: 2 });
  });
});

describe('storage-type probe (classifyRootDevice)', () => {
  let dir: string;
  const prev: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'storage-probe-'));
    for (const k of [ENV_SYS, ENV_CGROUP]) prev[k] = process.env[k];
    process.env[ENV_SYS] = join(dir, 'sys');
    process.env[ENV_CGROUP] = join(dir, 'cgroup');
    await mkdir(join(dir, 'cgroup'), { recursive: true });
  });

  afterEach(async () => {
    for (const k of [ENV_SYS, ENV_CGROUP]) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  // Build a fake /host/sys where device `maj:min` is a partition (or the whole
  // disk) on `device`, with the disk dir carrying queue/rotational. Mirrors the
  // real sysfs layout the probe walks: /sys/dev/block/<maj:min> is a relative
  // symlink into .../devices/.../block/DISK[/PART].
  async function fakeSys(opts: {
    maj: number;
    min: number;
    device: string;
    rotational: string;
    partition?: boolean;
  }): Promise<void> {
    const sys = join(dir, 'sys');
    const diskRel = `../../devices/virtual/block/${opts.device}`;
    const diskAbs = join(sys, 'devices/virtual/block', opts.device);
    await mkdir(join(diskAbs, 'queue'), { recursive: true });
    await writeFile(join(diskAbs, 'queue', 'rotational'), opts.rotational + '\n');
    await mkdir(join(sys, 'dev/block'), { recursive: true });
    const linkName = join(sys, 'dev/block', `${opts.maj}:${opts.min}`);
    if (opts.partition === false) {
      await symlink(diskRel, linkName);
    } else {
      const part = `${opts.device}p2`;
      await mkdir(join(diskAbs, part), { recursive: true });
      await symlink(`${diskRel}/${part}`, linkName);
    }
  }

  async function fakeIoPressure(someAvg10: string): Promise<void> {
    await writeFile(
      join(dir, 'cgroup', 'io.pressure'),
      `some avg10=${someAvg10} avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n`,
    );
  }

  it("flags an mmcblk root as 'warn' with the SSD advice and PSI note", async () => {
    await fakeSys({ maj: 179, min: 2, device: 'mmcblk0', rotational: '0' });
    await fakeIoPressure('4.20');
    const r = await classifyRootDevice(179, 2);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/SD card \(mmcblk0\)/);
    expect(r.message).toMatch(/SSD/);
    expect(r.message).toContain('avg10=4.2%');
    expect(r.details).toMatchObject({ device: 'mmcblk0', kind: 'sd-card', rotational: 0 });
  });

  it("reports an NVMe root as 'ok'", async () => {
    await fakeSys({ maj: 259, min: 2, device: 'nvme0n1', rotational: '0' });
    const r = await classifyRootDevice(259, 2);
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ device: 'nvme0n1', kind: 'ssd' });
  });

  it("reports a non-rotational sd device as an SSD ('ok')", async () => {
    await fakeSys({ maj: 8, min: 2, device: 'sda', rotational: '0' });
    const r = await classifyRootDevice(8, 2);
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ device: 'sda', kind: 'ssd' });
  });

  it("reports a rotational sd device as an HDD ('ok', not the SD problem)", async () => {
    await fakeSys({ maj: 8, min: 2, device: 'sda', rotational: '1' });
    const r = await classifyRootDevice(8, 2);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/spinning disk/);
    expect(r.details).toMatchObject({ device: 'sda', kind: 'hdd' });
  });

  it('resolves a whole-disk root (no partition) via the disk own queue/', async () => {
    await fakeSys({ maj: 8, min: 0, device: 'sda', rotational: '1', partition: false });
    const r = await classifyRootDevice(8, 0);
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ device: 'sda' });
  });

  it("returns 'unknown' when /host/sys can't resolve the device (older quadlet)", async () => {
    // No fakeSys() — /host/sys/dev/block/<maj:min> doesn't exist.
    const r = await classifyRootDevice(8, 2);
    expect(r.status).toBe('unknown');
    expect(r.message).toMatch(/could not resolve the root block device/);
  });
});
