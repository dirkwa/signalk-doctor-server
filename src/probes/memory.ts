import { freemem, totalmem } from 'node:os';
import type { ProbeResult } from './types.js';

const WARN_BYTES = 256 * 1024 * 1024;
const FAIL_BYTES = 96 * 1024 * 1024;

export async function probeMemory(): Promise<ProbeResult> {
  const t0 = Date.now();
  const free = freemem();
  const total = totalmem();
  const status = free < FAIL_BYTES ? 'fail' : free < WARN_BYTES ? 'warn' : 'ok';
  const fmt = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MiB`;
  return {
    id: 'memory',
    label: 'Free RAM',
    status,
    message: `${fmt(free)} free of ${fmt(total)}`,
    details: { freeBytes: free, totalBytes: total },
    durationMs: Date.now() - t0,
  };
}
