import { statfs } from 'node:fs/promises';
import type { ProbeResult } from './types.js';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const WARN_BYTES = 1024 * 1024 * 1024; // 1 GiB
const FAIL_BYTES = 256 * 1024 * 1024; // 256 MiB

export async function probeDisk(): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const s = await statfs(DATA_DIR);
    const free = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    const status = free < FAIL_BYTES ? 'fail' : free < WARN_BYTES ? 'warn' : 'ok';
    const fmt = (n: number): string => `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
    return {
      id: 'disk',
      label: 'Disk free on /data',
      status,
      message: `${fmt(free)} free of ${fmt(total)}`,
      details: { freeBytes: free, totalBytes: total, mount: DATA_DIR },
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      id: 'disk',
      label: 'Disk free on /data',
      status: 'unknown',
      message: err instanceof Error ? err.message : 'unknown error',
      durationMs: Date.now() - t0,
    };
  }
}
