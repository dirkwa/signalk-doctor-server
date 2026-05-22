import type { ProbeResult } from './types.js';
import { resolveRuntime } from '../podman/client.js';

async function probeOne(name: string, label: string): Promise<ProbeResult> {
  const t0 = Date.now();
  const rt = await resolveRuntime();
  if (!rt) {
    return {
      id: `container-${name}`,
      label,
      status: 'unknown',
      message: 'runtime unreachable',
      durationMs: Date.now() - t0,
    };
  }
  try {
    const info = (await rt.client.getContainer(name).inspect()) as unknown as {
      State?: { Status?: string; Running?: boolean; StartedAt?: string };
    };
    const running = info.State?.Running ?? false;
    return {
      id: `container-${name}`,
      label,
      status: running ? 'ok' : 'fail',
      message: running
        ? `${name} is running (since ${info.State?.StartedAt ?? 'unknown'})`
        : `${name} is ${info.State?.Status ?? 'not running'}`,
      details: { state: info.State?.Status, startedAt: info.State?.StartedAt },
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such container/i.test(msg) || /404/i.test(msg)) {
      return {
        id: `container-${name}`,
        label,
        status: 'fail',
        message: `${name} container is missing`,
        durationMs: Date.now() - t0,
      };
    }
    return {
      id: `container-${name}`,
      label,
      status: 'fail',
      message: msg,
      durationMs: Date.now() - t0,
    };
  }
}

export async function probeSignalkContainer(): Promise<ProbeResult> {
  return probeOne('signalk-server', 'SignalK Server container');
}

export async function probeUpdaterContainer(): Promise<ProbeResult> {
  return probeOne('signalk-updater-server', 'SignalK Updater container');
}
