import type { ProbeResult } from './types.js';
import { probePodman } from './podman.js';
import { probeSignalkContainer, probeUpdaterContainer } from './containers.js';
import { probeSignalkHealth } from './signalk-health.js';
import { probeUpdaterHealth } from './updater-health.js';
import { probeDbus } from './dbus.js';
import { probeDisk } from './disk.js';
import { probeMemory } from './memory.js';
import { probeTimeDrift } from './time-drift.js';
import { probeSnapshots } from './snapshots.js';

const PROBES = [
  probePodman,
  probeDbus,
  probeSignalkContainer,
  probeUpdaterContainer,
  probeSignalkHealth,
  probeUpdaterHealth,
  probeSnapshots,
  probeDisk,
  probeMemory,
  probeTimeDrift,
];

export async function runAllProbes(): Promise<{
  ranAt: string;
  durationMs: number;
  results: ProbeResult[];
  summary: { ok: number; warn: number; fail: number; unknown: number };
}> {
  const t0 = Date.now();
  const results = await Promise.all(PROBES.map((p) => p().catch((err) => failed(p.name, err))));
  const summary = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const r of results) summary[r.status]++;
  return {
    ranAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    results,
    summary,
  };
}

function failed(name: string, err: unknown): ProbeResult {
  return {
    id: name,
    label: name,
    status: 'unknown',
    message: err instanceof Error ? err.message : String(err),
    durationMs: 0,
  };
}
