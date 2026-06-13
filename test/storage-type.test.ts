import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeStorageType, baseBlockDevice } from '../src/probes/storage-type.js';

const ENV_BLOCK = 'HOST_BLOCK';
const ENV_MOUNTS = 'HOST_MOUNTS';
const ENV_CGROUP = 'HOST_CGROUP_ROOT';

describe('baseBlockDevice', () => {
  it('strips the pN partition suffix from mmcblk / nvme', () => {
    expect(baseBlockDevice('/dev/mmcblk0p2')).toBe('mmcblk0');
    expect(baseBlockDevice('/dev/nvme0n1p2')).toBe('nvme0n1');
  });

  it('returns the whole-device name unchanged', () => {
    expect(baseBlockDevice('/dev/mmcblk0')).toBe('mmcblk0');
    expect(baseBlockDevice('/dev/nvme0n1')).toBe('nvme0n1');
  });

  it('strips trailing partition digits from sd/vd/hd', () => {
    expect(baseBlockDevice('/dev/sda1')).toBe('sda');
    expect(baseBlockDevice('/dev/sda')).toBe('sda');
    expect(baseBlockDevice('/dev/vdb3')).toBe('vdb');
  });

  it('returns null for non-/dev nodes', () => {
    expect(baseBlockDevice('overlay')).toBeNull();
    expect(baseBlockDevice('tmpfs')).toBeNull();
  });
});

describe('storage-type probe', () => {
  let dir: string;
  const prevBlock = process.env[ENV_BLOCK];
  const prevMounts = process.env[ENV_MOUNTS];
  const prevCgroup = process.env[ENV_CGROUP];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'storage-probe-'));
    process.env[ENV_BLOCK] = join(dir, 'block');
    process.env[ENV_MOUNTS] = join(dir, 'mounts');
    process.env[ENV_CGROUP] = join(dir, 'cgroup');
    await mkdir(join(dir, 'cgroup'), { recursive: true });
  });

  afterEach(async () => {
    const restore = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore(ENV_BLOCK, prevBlock);
    restore(ENV_MOUNTS, prevMounts);
    restore(ENV_CGROUP, prevCgroup);
    await rm(dir, { recursive: true, force: true });
  });

  async function writeMounts(...lines: string[]): Promise<void> {
    await writeFile(join(dir, 'mounts'), lines.join('\n') + '\n');
  }
  async function writeRotational(base: string, value: string): Promise<void> {
    const qdir = join(dir, 'block', base, 'queue');
    await mkdir(qdir, { recursive: true });
    await writeFile(join(qdir, 'rotational'), value + '\n');
  }
  async function writeIoPressure(some: string): Promise<void> {
    await writeFile(
      join(dir, 'cgroup', 'io.pressure'),
      `some avg10=${some} avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
    );
  }

  it("returns 'unknown' when the host mounts file is missing", async () => {
    const r = await probeStorageType();
    expect(r.id).toBe('storage-type');
    expect(r.status).toBe('unknown');
    expect(r.message).toMatch(/missing the host mounts/);
  });

  it("flags an SD-card root as 'warn' with the SSD advice", async () => {
    await writeMounts(
      'proc /proc proc rw 0 0',
      '/dev/mmcblk0p2 / ext4 rw,relatime 0 0',
      '/dev/mmcblk0p1 /boot/firmware vfat rw 0 0',
    );
    await writeRotational('mmcblk0', '0');
    await writeIoPressure('4.20');
    const r = await probeStorageType();
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/SD card \(mmcblk0\)/);
    expect(r.message).toMatch(/SSD/);
    expect(r.message).toContain('avg10=4.2%');
    expect(r.details).toMatchObject({ device: 'mmcblk0', kind: 'sd-card' });
  });

  it("reports an NVMe root as 'ok'", async () => {
    await writeMounts('/dev/nvme0n1p2 / ext4 rw 0 0');
    await writeRotational('nvme0n1', '0');
    const r = await probeStorageType();
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ device: 'nvme0n1', kind: 'ssd' });
  });

  it("reports a non-rotational sd device as an SSD ('ok')", async () => {
    await writeMounts('/dev/sda1 / ext4 rw 0 0');
    await writeRotational('sda', '0');
    const r = await probeStorageType();
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ device: 'sda', kind: 'ssd' });
  });

  it("reports a rotational sd device as an HDD ('ok', not the SD problem)", async () => {
    await writeMounts('/dev/sda1 / ext4 rw 0 0');
    await writeRotational('sda', '1');
    const r = await probeStorageType();
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ device: 'sda', kind: 'hdd' });
  });

  it("returns 'unknown' when there is no root mount", async () => {
    await writeMounts('proc /proc proc rw 0 0', 'tmpfs /run tmpfs rw 0 0');
    const r = await probeStorageType();
    expect(r.status).toBe('unknown');
    expect(r.message).toMatch(/no root \(\/\) mount/);
  });
});
