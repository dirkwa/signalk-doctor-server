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
import { probeVersionDrift } from './version-drift.js';
import { probeTimezoneDrift } from './timezone-drift.js';
import { probeDependencyDrift } from './dependency-drift.js';
import { probeCgroupDelegation } from './cgroup-delegation.js';
import { probeStorageType } from './storage-type.js';

interface ProbeSpec {
  /** The stable id the probe emits on its own ProbeResult. Declared here
   *  so the runner can label a timed-out or thrown probe with the SAME id
   *  the probe would have used had it completed — otherwise a degraded
   *  probe surfaces under a different key (its function name) than the
   *  healthy one, and any client tracking probe status by id sees them as
   *  two distinct probes. Mirror the id/label each probe hardcodes; a
   *  drift is caught by the runner-registry test. */
  id: string;
  label: string;
  run: () => Promise<ProbeResult>;
}

const PROBES: ProbeSpec[] = [
  { id: 'podman', label: 'Container runtime', run: probePodman },
  { id: 'dbus', label: 'User-instance DBus socket', run: probeDbus },
  { id: 'container-signalk-server', label: 'SignalK Server container', run: probeSignalkContainer },
  {
    id: 'container-signalk-updater-server',
    label: 'SignalK Updater container',
    run: probeUpdaterContainer,
  },
  { id: 'signalk-health', label: 'SignalK server HTTP health', run: probeSignalkHealth },
  { id: 'updater-health', label: 'Updater HTTP health', run: probeUpdaterHealth },
  { id: 'version-drift', label: 'Version drift', run: probeVersionDrift },
  { id: 'timezone-drift', label: 'Timezone drift', run: () => probeTimezoneDrift() },
  { id: 'dependency-drift', label: 'Dependency drift', run: probeDependencyDrift },
  { id: 'snapshots', label: 'Quadlet snapshots', run: probeSnapshots },
  { id: 'disk', label: 'Disk free on /data', run: probeDisk },
  { id: 'memory', label: 'Free RAM', run: probeMemory },
  { id: 'time-drift', label: 'System clock vs ghcr.io', run: probeTimeDrift },
  { id: 'cgroup-delegation', label: 'cgroup controller delegation', run: probeCgroupDelegation },
  { id: 'storage-type', label: 'Host root storage', run: probeStorageType },
];

// Upper bound on how long any single probe may run before the runner gives
// up on it and marks it `unknown`. Without this, one wedged probe hangs the
// whole `/api/probes` response: the heaviest probe is `podman` (a dockerode
// call over the rootless socket), which on a contended/half-up cold boot can
// block long past the plugin proxy's 15s header watchdog — turning a slow
// probe into the alarming "Failed to run probes: HTTP 502". 8s is comfortably
// above the observed healthy worst case (podman ~2.7s, check-update ~10.5s
// pre-Happy-Eyeballs but now bounded by the 5s autoSelectFamily attempt) yet
// well under the proxy's 15s ceiling, so a single stuck probe degrades to
// `unknown` while the other twelve still report. Env-overridable so tests can
// shrink it without sleeping the runner; floored at 250ms.
function probeTimeoutMs(): number {
  const raw = Number(process.env.PROBE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.max(250, raw) : 8000;
}

export async function runAllProbes(): Promise<{
  ranAt: string;
  durationMs: number;
  results: ProbeResult[];
  summary: { ok: number; warn: number; fail: number; unknown: number };
}> {
  const t0 = Date.now();
  const timeoutMs = probeTimeoutMs();
  const results = await Promise.all(PROBES.map((spec) => runWithTimeout(spec, timeoutMs)));
  const summary = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const r of results) summary[r.status]++;
  return {
    ranAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    results,
    summary,
  };
}

/** Race a single probe against a per-probe timeout. On timeout — or on an
 *  unexpected throw — we resolve with an honest `unknown` ProbeResult under
 *  the probe's OWN declared id/label, rather than rejecting or dropping it:
 *  the degraded probe must surface as "we couldn't tell" keyed the same way
 *  it would be when healthy (the doctor's whole value is honest status). The
 *  underlying probe promise keeps running but its eventual result is
 *  discarded; probes are read-only so a late completion has no side effect. */
function runWithTimeout(spec: ProbeSpec, timeoutMs: number): Promise<ProbeResult> {
  const t0 = Date.now();
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(
        degraded(spec, `probe did not finish within ${timeoutMs}ms (timed out)`, Date.now() - t0),
      );
    }, timeoutMs);
    spec.run().then(
      (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(degraded(spec, err instanceof Error ? err.message : String(err), Date.now() - t0));
      },
    );
  });
}

function degraded(spec: ProbeSpec, message: string, durationMs: number): ProbeResult {
  return {
    id: spec.id,
    label: spec.label,
    status: 'unknown',
    message,
    durationMs,
  };
}
