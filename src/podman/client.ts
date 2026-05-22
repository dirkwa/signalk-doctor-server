import Docker from 'dockerode';
import { stat } from 'node:fs/promises';
import type { RuntimeKind } from '../types.js';
import { categorizeError, type CategorizedError } from '../errors.js';

const DEFAULT_SOCKETS = [
  '/var/run/docker.sock',
  `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`,
  '/run/podman/podman.sock',
];

export interface ResolvedRuntime {
  client: Docker;
  socketPath: string;
  kind: RuntimeKind;
}

async function pickSocket(): Promise<string | null> {
  for (const candidate of DEFAULT_SOCKETS) {
    try {
      const s = await stat(candidate);
      if (s.isSocket()) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

async function detectKind(client: Docker): Promise<RuntimeKind> {
  try {
    const v = await client.version();
    const components = (v as { Components?: Array<{ Name?: string }> }).Components ?? [];
    if (components.some((c) => /podman/i.test(c.Name ?? ''))) return 'podman';
    if (v.Platform?.Name && /podman/i.test(v.Platform.Name)) return 'podman';
    return 'docker';
  } catch {
    return 'unknown';
  }
}

export async function resolveRuntime(): Promise<ResolvedRuntime | null> {
  const socketPath = await pickSocket();
  if (!socketPath) return null;
  const client = new Docker({ socketPath });
  const kind = await detectKind(client);
  return { client, socketPath, kind };
}

export async function safe<T>(
  op: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: CategorizedError }> {
  try {
    return { ok: true, value: await op() };
  } catch (err) {
    return { ok: false, error: categorizeError(err) };
  }
}
