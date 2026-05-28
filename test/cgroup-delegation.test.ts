import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeCgroupDelegation,
  __resetHostUidCacheForTests,
} from '../src/probes/cgroup-delegation.js';

const ENV_ROOT = 'HOST_CGROUP_ROOT';
const ENV_CMDLINE = 'HOST_CMDLINE_PATH';
const ENV_UID_MAP = 'UID_MAP_PATH';

describe('cgroup-delegation probe', () => {
  let dir: string;
  const prevRoot = process.env[ENV_ROOT];
  const prevCmd = process.env[ENV_CMDLINE];
  const prevUidMap = process.env[ENV_UID_MAP];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cgroup-probe-'));
    process.env[ENV_ROOT] = dir;
    process.env[ENV_CMDLINE] = join(dir, 'cmdline');
    // Each test starts with a fresh host-UID resolution so the env
    // overrides below are honoured rather than picking up a cached
    // value from a prior test.
    __resetHostUidCacheForTests();
  });

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env[ENV_ROOT];
    else process.env[ENV_ROOT] = prevRoot;
    if (prevCmd === undefined) delete process.env[ENV_CMDLINE];
    else process.env[ENV_CMDLINE] = prevCmd;
    if (prevUidMap === undefined) delete process.env[ENV_UID_MAP];
    else process.env[ENV_UID_MAP] = prevUidMap;
    await rm(dir, { recursive: true, force: true });
    __resetHostUidCacheForTests();
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

  describe('host UID resolution (rootless userns)', () => {
    // Under rootless podman, process.getuid() inside the container is 0
    // but the host slice we need to look at is user-<HOSTUID>.slice. The
    // probe parses /proc/self/uid_map to translate; here we simulate that
    // mapping with a fixture file and verify the probe lands on the host
    // slice rather than user-0.slice.
    async function writeUidMap(contents: string): Promise<void> {
      const p = join(dir, 'uid_map');
      await writeFile(p, contents);
      process.env[ENV_UID_MAP] = p;
      __resetHostUidCacheForTests();
    }

    async function writeUserSliceForUid(uid: number, controllers: string): Promise<void> {
      const sliceDir = join(dir, 'user.slice', `user-${uid}.slice`);
      await mkdir(sliceDir, { recursive: true });
      await writeFile(join(sliceDir, 'cgroup.controllers'), controllers);
    }

    // The test runner isn't actually in a userns, so we map *its real
    // uid* to a chosen "host" uid via the fake uid_map — that lets us
    // simulate "in-container uid -> different host uid" deterministically
    // regardless of what `process.getuid()` happens to be in CI.
    const RUN_UID = process.getuid?.() ?? 0;
    const HOST_UID = RUN_UID + 4242; // arbitrary distinct uid

    it('uses the host uid from uid_map (not the in-container uid) when picking the user slice', async () => {
      await writeUidMap(`${RUN_UID} ${HOST_UID} 1\n`);
      await writeRoot('cpuset cpu io memory pids');
      await writeUserSliceForUid(HOST_UID, 'cpuset cpu io memory pids');
      const r = await probeCgroupDelegation();
      expect(r.status).toBe('ok');
      expect(r.message).toContain(`user-${HOST_UID}.slice`);
    });

    it("returns 'unknown' against the mapped host slice when it isn't materialised (regression guard for the in-container vs host UID bug)", async () => {
      await writeUidMap(`${RUN_UID} ${HOST_UID} 1\n`);
      await writeRoot('cpuset cpu io memory pids');
      // Write the *wrong* slice (in-container uid) to prove the probe
      // doesn't pick it up by accident.
      await writeUserSliceForUid(RUN_UID, 'cpuset cpu io memory pids');
      const r = await probeCgroupDelegation();
      expect(r.status).toBe('unknown');
      expect((r.details as Record<string, unknown>).userSlicePath).toContain(
        `user-${HOST_UID}.slice`,
      );
    });

    it('falls back to getuid() when uid_map is missing', async () => {
      // No UID_MAP_PATH override and no file at the default path — the
      // probe should still behave (identity fallback). With the test
      // runner's real uid, writing the matching user slice yields 'ok'.
      process.env[ENV_UID_MAP] = join(dir, 'does-not-exist');
      __resetHostUidCacheForTests();
      await writeRoot('cpuset cpu io memory pids');
      await writeUserSliceForUid(process.getuid?.() ?? 0, 'cpuset cpu io memory pids');
      const r = await probeCgroupDelegation();
      expect(r.status).toBe('ok');
    });
  });
});
