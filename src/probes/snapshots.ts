import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeResult } from './types.js';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const SNAPSHOT_DIR = join(DATA_DIR, 'snapshots');

export async function probeSnapshots(): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const entries = await readdir(SNAPSHOT_DIR).catch(() => [] as string[]);
    if (entries.length === 0) {
      return {
        id: 'snapshots',
        label: 'Quadlet snapshots',
        status: 'warn',
        message: `${SNAPSHOT_DIR} is empty — no recovery snapshots yet`,
        durationMs: Date.now() - t0,
      };
    }
    let newest = 0;
    for (const e of entries) {
      const s = await stat(join(SNAPSHOT_DIR, e));
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    }
    const ageHours = (Date.now() - newest) / (1000 * 3600);
    return {
      id: 'snapshots',
      label: 'Quadlet snapshots',
      status: 'ok',
      message: `${entries.length} snapshot${entries.length === 1 ? '' : 's'}; newest ${ageHours.toFixed(1)}h ago`,
      details: { count: entries.length, newestAgeHours: ageHours },
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      id: 'snapshots',
      label: 'Quadlet snapshots',
      status: 'unknown',
      message: err instanceof Error ? err.message : 'unknown',
      durationMs: Date.now() - t0,
    };
  }
}
