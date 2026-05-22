import type { ProbeResult } from './types.js';

// Compare local time against ghcr.io's HTTP Date header. Best-effort; offline-tolerant.
export async function probeTimeDrift(): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch('https://ghcr.io/v2/', { method: 'HEAD', signal: controller.signal });
      const dateHeader = res.headers.get('date');
      if (!dateHeader) {
        return {
          id: 'time-drift',
          label: 'System clock vs ghcr.io',
          status: 'unknown',
          message: 'ghcr.io returned no Date header',
          durationMs: Date.now() - t0,
        };
      }
      const remote = new Date(dateHeader).getTime();
      const driftSec = Math.round(Math.abs(Date.now() - remote) / 1000);
      const status = driftSec > 86400 ? 'warn' : driftSec > 300 ? 'warn' : 'ok';
      return {
        id: 'time-drift',
        label: 'System clock vs ghcr.io',
        status,
        message:
          driftSec === 0
            ? 'in sync'
            : driftSec < 60
              ? `${driftSec}s drift (ok)`
              : driftSec < 3600
                ? `${Math.round(driftSec / 60)}m drift`
                : `${Math.round(driftSec / 3600)}h drift — clock may need NTP`,
        details: { driftSec },
        durationMs: Date.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      id: 'time-drift',
      label: 'System clock vs ghcr.io',
      status: 'unknown',
      message: err instanceof Error ? err.message : 'unknown',
      durationMs: Date.now() - t0,
    };
  }
}
