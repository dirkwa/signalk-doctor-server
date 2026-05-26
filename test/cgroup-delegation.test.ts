import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCgroupDelegation } from '../src/probes/cgroup-delegation.js';

const ENV_ROOT = 'HOST_CGROUP_ROOT';
const ENV_CMDLINE = 'HOST_CMDLINE_PATH';

describe('cgroup-delegation probe', () => {
  let dir: string;
  const prevRoot = process.env[ENV_ROOT];
  const prevCmd = process.env[ENV_CMDLINE];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cgroup-probe-'));
    process.env[ENV_ROOT] = dir;
    process.env[ENV_CMDLINE] = join(dir, 'cmdline');
  });

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env[ENV_ROOT];
    else process.env[ENV_ROOT] = prevRoot;
    if (prevCmd === undefined) delete process.env[ENV_CMDLINE];
    else process.env[ENV_CMDLINE] = prevCmd;
    await rm(dir, { recursive: true, force: true });
  });

  async function writeRoot(controllers: string): Promise<void> {
    await writeFile(join(dir, 'cgroup.controllers'), controllers);
  }

  async function writeUserSlice(controllers: string): Promise<void> {
    const uid = process.getuid?.() ?? 0;
    const sliceDir = join(dir, 'user.slice', `user-${uid}.slice`);
    await mkdir(sliceDir, { recursive: true });
    await writeFile(join(sliceDir, 'cgroup.controllers'), controllers);
  }

  async function writeCmdline(line: string): Promise<void> {
    await writeFile(join(dir, 'cmdline'), line);
  }

  it("returns 'unknown' when host cgroup mount is missing", async () => {
    const r = await probeCgroupDelegation();
    expect(r.status).toBe('unknown');
    expect(r.id).toBe('cgroup-delegation');
    expect(r.message).toMatch(/missing the host cgroup mount/);
  });

  it("returns 'ok' when both layers have memory + pids", async () => {
    await writeRoot('cpuset cpu io memory pids');
    await writeUserSlice('cpuset cpu io memory pids');
    const r = await probeCgroupDelegation();
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ layer: 0 });
  });

  it("returns 'fail' with Trixie cmdline recipe when cgroup_disable=memory present", async () => {
    await writeRoot('cpuset cpu io pids');
    await writeCmdline(
      'console=serial0,115200 root=PARTUUID=abc rootfstype=ext4 cgroup_disable=memory quiet',
    );
    const r = await probeCgroupDelegation();
    expect(r.status).toBe('fail');
    expect(r.details).toMatchObject({ layer: 1, kernelCmdlineHasDisableMemory: true });
    expect(r.message).toMatch(/cgroup_disable=memory/);
    expect(r.message).toMatch(/sed -i.*cgroup_disable=memory/);
  });

  it("returns 'fail' with generic append recipe when cgroup_disable=memory absent", async () => {
    await writeRoot('cpuset cpu io pids');
    await writeCmdline('console=serial0,115200 root=PARTUUID=abc rootfstype=ext4 quiet');
    const r = await probeCgroupDelegation();
    expect(r.status).toBe('fail');
    expect(r.details).toMatchObject({ layer: 1, kernelCmdlineHasDisableMemory: false });
    expect(r.message).not.toMatch(/cgroup_disable=memory/);
    expect(r.message).toMatch(/cgroup_enable=memory cgroup_memory=1/);
  });

  it("returns 'fail' with generic recipe when cmdline file is unreadable", async () => {
    // /proc/cmdline not mounted (env points at a nonexistent file).
    await writeRoot('cpuset cpu io pids');
    const r = await probeCgroupDelegation();
    expect(r.status).toBe('fail');
    expect(r.details).toMatchObject({ layer: 1, kernelCmdlineHasDisableMemory: false });
  });

  it("returns 'warn' when root OK but user slice is missing pids", async () => {
    await writeRoot('cpuset cpu io memory pids');
    await writeUserSlice('cpu memory');
    const r = await probeCgroupDelegation();
    expect(r.status).toBe('warn');
    expect(r.details).toMatchObject({ layer: 2 });
    expect(r.details).toHaveProperty('userMissing');
    expect((r.details as Record<string, unknown>).userMissing).toEqual(['pids']);
    expect(r.message).toMatch(/Delegate=cpu cpuset io memory pids/);
  });

  it("returns 'unknown' when root OK but user slice file is absent", async () => {
    await writeRoot('cpuset cpu io memory pids');
    // No user.slice/.../cgroup.controllers written.
    const r = await probeCgroupDelegation();
    expect(r.status).toBe('unknown');
    expect(r.details).toMatchObject({ layer: 2 });
  });
});
