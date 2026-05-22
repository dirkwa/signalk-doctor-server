import type { ProbeResult } from './types.js';
import { resolveRuntime } from '../podman/client.js';

export async function probePodman(): Promise<ProbeResult> {
  const t0 = Date.now();
  const rt = await resolveRuntime();
  if (!rt) {
    return {
      id: 'podman',
      label: 'Container runtime',
      status: 'fail',
      message: 'No reachable Podman or Docker socket. Check /run/user/$UID/podman/podman.sock.',
      durationMs: Date.now() - t0,
    };
  }
  try {
    const v = await rt.client.version();
    return {
      id: 'podman',
      label: 'Container runtime',
      status: 'ok',
      message: `${rt.kind} ${(v as { Version?: string }).Version ?? 'unknown'} at ${rt.socketPath}`,
      details: {
        kind: rt.kind,
        socketPath: rt.socketPath,
        apiVersion: (v as { ApiVersion?: string }).ApiVersion,
      },
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      id: 'podman',
      label: 'Container runtime',
      status: 'fail',
      message: err instanceof Error ? err.message : 'unknown error',
      durationMs: Date.now() - t0,
    };
  }
}
