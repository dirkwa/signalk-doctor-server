import { open, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DriftReport } from './types.js';

// Resolved at request time so tests can override DOCTOR_DATA between scans
// (and so an installer can adjust the mount path without rebuilding).
function doctorData(): string {
  return process.env.DOCTOR_DATA ?? '/data';
}
function driftPath(): string {
  return join(doctorData(), 'drift.json');
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeAtomic(filePath: string, body: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.write(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, filePath);
  await fsyncDir(dirname(filePath));
}

export async function loadDriftReport(): Promise<DriftReport | null> {
  try {
    const raw = await readFile(driftPath(), 'utf8');
    return JSON.parse(raw) as DriftReport;
  } catch {
    return null;
  }
}

export async function saveDriftReport(report: DriftReport): Promise<void> {
  await mkdir(doctorData(), { recursive: true });
  await writeAtomic(driftPath(), JSON.stringify(report, null, 2));
}
