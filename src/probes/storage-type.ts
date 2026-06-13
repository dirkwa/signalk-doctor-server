import { stat, readFile, readlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProbeResult } from './types.js';

// Host-mounted by the doctor quadlet (see signalk-universal-installer
// quadlets/signalk-doctor-server.container.template):
//   Volume=/sys:/host/sys:ro
//
// We resolve the device backing /data (the doctor's data dir, which lives on
// the host root filesystem) rather than parsing a mount table: /proc/mounts is
// a symlink to self/mounts and can't be bind-mounted into a userns'd container
// (it reads back EINVAL), and binding only /sys/block misses the symlink
// targets under /sys/devices. /sys/dev/block/<maj:min> is keyed by device
// number and resolves the whole device tree, so a single /sys mount suffices.
// io.pressure comes from the cgroup mount the cgroup-delegation probe relies
// on. Read per-call so tests can override via env without bouncing the module.
const sysRoot = (): string => process.env.HOST_SYS ?? '/host/sys';
const dataDir = (): string => process.env.DATA_DIR ?? '/data';
const cgroupRoot = (): string => process.env.HOST_CGROUP_ROOT ?? '/host/cgroup';

const ID = 'storage-type';
const LABEL = 'Host root storage';

type StorageKind = 'sd-card' | 'ssd' | 'hdd' | 'unknown';

/** Resolve the whole-disk sysfs directory backing a device number. From
 *  /host/sys/dev/block/<maj:min> (a symlink into .../devices/.../block/DISK or
 *  .../block/DISK/PART) we walk up until a directory has a `queue/` child —
 *  that marks the disk (partitions don't have one). Returns { dir, device } or
 *  null if the chain can't be followed. */
async function resolveDisk(
  maj: number,
  min: number,
): Promise<{ dir: string; device: string } | null> {
  const link = join(sysRoot(), 'dev', 'block', `${maj}:${min}`);
  let target: string;
  try {
    // The symlink is relative (../../devices/...); resolve against its dir.
    target = resolve(dirname(link), await readlink(link));
  } catch {
    return null;
  }
  // Walk up at most a few levels looking for the disk (the dir with queue/).
  let cur = target;
  for (let i = 0; i < 4; i++) {
    try {
      const s = await stat(join(cur, 'queue'));
      if (s.isDirectory()) return { dir: cur, device: basename(cur) };
    } catch {
      // no queue/ here — keep walking up
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function classify(device: string, rotational: number | null): StorageKind {
  if (device.startsWith('mmcblk')) return 'sd-card';
  if (device.startsWith('nvme')) return 'ssd';
  if (rotational === 0) return 'ssd';
  if (rotational === 1) return 'hdd';
  return 'unknown';
}

async function readRotational(diskDir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(diskDir, 'queue', 'rotational'), 'utf-8');
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** PSI "some" I/O pressure over the last 10s, if the host kernel exposes it
 *  (cgroup v2 + CONFIG_PSI). Enriches the SD-card warning with evidence that
 *  the disk is actually stalling tasks rather than just being slow in theory.
 *  Best-effort: null when unavailable. */
async function readIoPressureSomeAvg10(): Promise<number | null> {
  try {
    const raw = await readFile(join(cgroupRoot(), 'io.pressure'), 'utf-8');
    // `some avg10=1.23 avg60=... avg300=... total=...`
    const m = /some\b[^\n]*\bavg10=([\d.]+)/.exec(raw);
    if (!m?.[1]) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Decode a kernel device number (glibc gnu_dev_major/minor, matching Node's
 *  st.dev encoding) into major:minor. Exported for tests. */
export function decodeDev(dev: number): { maj: number; min: number } {
  const d = BigInt(dev);
  return {
    maj: Number(((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn)),
    min: Number((d & 0xffn) | ((d >> 12n) & ~0xffn)),
  };
}

export async function probeStorageType(): Promise<ProbeResult> {
  const t0 = Date.now();

  let dev: number;
  try {
    dev = (await stat(dataDir())).dev;
  } catch (err) {
    return {
      id: ID,
      label: LABEL,
      status: 'unknown',
      message: `cannot stat ${dataDir()}: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - t0,
    };
  }
  const { maj, min } = decodeDev(dev);
  return classifyRootDevice(maj, min, t0);
}

/** Resolve and classify the root block device for a given device number. Split
 *  from probeStorageType so tests can drive the full sysfs walk + classification
 *  against a fixture /host/sys without faking stat() — the stat→maj:min step is
 *  covered end-to-end by the container e2e and by decodeDev's own test. */
export async function classifyRootDevice(
  maj: number,
  min: number,
  t0 = Date.now(),
): Promise<ProbeResult> {
  const disk = await resolveDisk(maj, min);
  if (!disk) {
    // No /host/sys mount (older quadlet) or the device tree couldn't be
    // followed. Non-blocking advisory, same posture as cgroup-delegation.
    return {
      id: ID,
      label: LABEL,
      status: 'unknown',
      message: `could not resolve the root block device (${maj}:${min}) under ${sysRoot()}/dev/block — doctor container may be missing the host /sys mount; refresh the doctor quadlet via signalk-universal-installer to enable this probe`,
      details: { maj, min },
      durationMs: Date.now() - t0,
    };
  }

  const rotational = await readRotational(disk.dir);
  const kind = classify(disk.device, rotational);
  const ioPressureSomeAvg10 = await readIoPressureSomeAvg10();
  const details = { device: disk.device, kind, rotational, ioPressureSomeAvg10 };

  if (kind === 'sd-card') {
    // The Pi-on-SD case. Not broken — but microSD random-I/O latency is what
    // stalls the Node event loop under load and makes a healthy engine answer
    // /api/health slowly enough to trip reachability probes. Surface it as a
    // warn with the actionable fix.
    const pressureNote =
      ioPressureSomeAvg10 !== null && ioPressureSomeAvg10 > 0
        ? ` (I/O pressure some avg10=${ioPressureSomeAvg10}%)`
        : '';
    return {
      id: ID,
      label: LABEL,
      status: 'warn',
      message: `root is on an SD card (${disk.device})${pressureNote} — works, but microSD I/O stalls are the usual cause of slow health/probe responses; moving root/overlay storage to a USB3 or NVMe SSD removes them`,
      details,
      durationMs: Date.now() - t0,
    };
  }

  const kindLabel =
    kind === 'ssd' ? 'SSD/flash' : kind === 'hdd' ? 'spinning disk' : 'unknown type';
  return {
    id: ID,
    label: LABEL,
    status: 'ok',
    message: `root is on ${disk.device} (${kindLabel})`,
    details,
    durationMs: Date.now() - t0,
  };
}
