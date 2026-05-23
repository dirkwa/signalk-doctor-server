import type { ProbeResult } from './types.js';

// Same reasoning as signalk-health.ts: 127.0.0.1 is the doctor's own
// container, not the host. Reach the updater via Podman's host gateway.
const UPDATER_URL = process.env.UPDATER_URL ?? 'http://host.containers.internal:3003/api/health';

export async function probeUpdaterHealth(): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(UPDATER_URL, { signal: controller.signal });
      if (!res.ok) {
        return {
          id: 'updater-health',
          label: 'Updater HTTP health',
          status: 'fail',
          message: `HTTP ${res.status} from ${UPDATER_URL}`,
          durationMs: Date.now() - t0,
        };
      }
      const body = (await res.json()) as { ok?: boolean; runtime?: string };
      return {
        id: 'updater-health',
        label: 'Updater HTTP health',
        status: body.ok ? 'ok' : 'warn',
        message: body.ok
          ? `Updater reports OK (runtime=${body.runtime})`
          : `Updater reachable but reports ok=false (runtime=${body.runtime})`,
        details: body as Record<string, unknown>,
        durationMs: Date.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: 'updater-health',
      label: 'Updater HTTP health',
      status: 'fail',
      message: `cannot reach ${UPDATER_URL}: ${msg}`,
      durationMs: Date.now() - t0,
    };
  }
}
