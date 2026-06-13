import { readFile } from 'node:fs/promises';
import type { ProbeResult } from './types.js';

// Host-mounted by the doctor quadlet (see signalk-universal-installer
// quadlets/signalk-doctor-server.container.template):
//   Volume=/sys/block:/host/block:ro
//   Volume=/proc/mounts:/host/proc/mounts:ro
// The container's own /proc shows the CONTAINER mount table, so the host's
// /proc/mounts must be bind-mounted explicitly to see the host root device.
// io.pressure comes from the cgroup mount the cgroup-delegation probe already
// relies on. Read per-call so tests can override via env without bouncing the
// module — runtime cost negligible.
const blockRoot = (): string => process.env.HOST_BLOCK ?? '/host/block';
const mountsPath = (): string => process.env.HOST_MOUNTS ?? '/host/proc/mounts';
const cgroupRoot = (): string => process.env.HOST_CGROUP_ROOT ?? '/host/cgroup';

const ID = 'storage-type';
const LABEL = 'Host root storage';

type StorageKind = 'sd-card' | 'ssd' | 'hdd' | 'unknown';

/** Map a device node (the first field of a /proc/mounts line) to its base
 *  block-device directory name under /sys/block. Partitions hang off their
 *  parent there, so a probe of /sys/block must use the parent:
 *    /dev/mmcblk0p2 -> mmcblk0   (and nvme0n1p2 -> nvme0n1: strip `p<N>`)
 *    /dev/sda1      -> sda       (trailing digits stripped)
 *  Returns null for non-/dev or device-mapper/loop/zram nodes we don't classify. */
export function baseBlockDevice(devNode: string): string | null {
  if (!devNode.startsWith('/dev/')) return null;
  const name = devNode.slice('/dev/'.length);
  // mmcblk0p2 / nvme0n1p2 — the partition suffix is `p` + digits.
  if (/^(mmcblk\d+|nvme\d+n\d+)p\d+$/.test(name)) {
    return name.replace(/p\d+$/, '');
  }
  if (/^(mmcblk\d+|nvme\d+n\d+)$/.test(name)) return name;
  // sdXN / vdXN / hdXN — strip trailing partition digits.
  const m = /^([a-z]+?)\d*$/.exec(name);
  return m ? (m[1] ?? null) : null;
}

/** The device backing `/` in a /proc/mounts dump. On a single-disk Pi this is
 *  the disk that carries both the OS and the rootless overlay store, so it's
 *  the one whose latency shows up as slow health/probe responses. */
function rootDevice(mounts: string): string | null {
  for (const line of mounts.split('\n')) {
    const [dev, mnt] = line.split(/\s+/);
    if (mnt === '/' && dev) return dev;
  }
  return null;
}

function classify(base: string, rotational: number | null): StorageKind {
  if (base.startsWith('mmcblk')) return 'sd-card';
  if (base.startsWith('nvme')) return 'ssd';
  if (rotational === 0) return 'ssd';
  if (rotational === 1) return 'hdd';
  return 'unknown';
}

async function readRotational(base: string): Promise<number | null> {
  try {
    const raw = await readFile(`${blockRoot()}/${base}/queue/rotational`, 'utf-8');
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
    const raw = await readFile(`${cgroupRoot()}/io.pressure`, 'utf-8');
    // `some avg10=1.23 avg60=... avg300=... total=...`
    const m = /some\b[^\n]*\bavg10=([\d.]+)/.exec(raw);
    if (!m?.[1]) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function probeStorageType(): Promise<ProbeResult> {
  const t0 = Date.now();

  let mounts: string;
  try {
    mounts = await readFile(mountsPath(), 'utf-8');
  } catch {
    // No /host/proc/mounts — operator is on an older quadlet that predates
    // this probe. Non-blocking advisory, same posture as cgroup-delegation.
    return {
      id: ID,
      label: LABEL,
      status: 'unknown',
      message: `${mountsPath()} not readable — doctor container is missing the host mounts; refresh the doctor quadlet via signalk-universal-installer to enable this probe`,
      durationMs: Date.now() - t0,
    };
  }

  const dev = rootDevice(mounts);
  const base = dev ? baseBlockDevice(dev) : null;
  if (!base) {
    return {
      id: ID,
      label: LABEL,
      status: 'unknown',
      message: dev
        ? `could not resolve a block device for root mount '${dev}'`
        : 'no root (/) mount found in host mount table',
      details: { rootDevice: dev },
      durationMs: Date.now() - t0,
    };
  }

  const rotational = await readRotational(base);
  const kind = classify(base, rotational);
  const ioPressureSomeAvg10 = await readIoPressureSomeAvg10();
  const details = { device: base, rootDevice: dev, kind, rotational, ioPressureSomeAvg10 };

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
      message: `root is on an SD card (${base})${pressureNote} — works, but microSD I/O stalls are the usual cause of slow health/probe responses; moving root/overlay storage to a USB3 or NVMe SSD removes them`,
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
    message: `root is on ${base} (${kindLabel})`,
    details,
    durationMs: Date.now() - t0,
  };
}
