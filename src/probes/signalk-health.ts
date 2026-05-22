import type { ProbeResult } from './types.js';

const SIGNALK_URL = process.env.SIGNALK_URL ?? 'http://127.0.0.1:3000/signalk';

export async function probeSignalkHealth(): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(SIGNALK_URL, { signal: controller.signal });
      const status = res.ok ? 'ok' : 'fail';
      return {
        id: 'signalk-health',
        label: 'SignalK server HTTP health',
        status: status,
        message: res.ok
          ? `HTTP ${res.status} from ${SIGNALK_URL}`
          : `HTTP ${res.status} from ${SIGNALK_URL}`,
        durationMs: Date.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: 'signalk-health',
      label: 'SignalK server HTTP health',
      status: 'fail',
      message: `cannot reach ${SIGNALK_URL}: ${msg}`,
      durationMs: Date.now() - t0,
    };
  }
}
