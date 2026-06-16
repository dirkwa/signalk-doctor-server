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

async function detectKind(client: Docker, socketPath: string): Promise<RuntimeKind> {
  try {
    const v = await client.version();
    const components = (v as { Components?: Array<{ Name?: string }> }).Components ?? [];
    if (components.some((c) => /podman/i.test(c.Name ?? ''))) return 'podman';
    if (v.Platform?.Name && /podman/i.test(v.Platform.Name)) return 'podman';
    return 'docker';
  } catch {
    // /version failed (commonly: socket exists but our uid can't read it).
    // Fall back to a heuristic based on socket path: the rootless-podman
    // socket lives under /run/user/<uid>/podman/, the system-wide podman
    // socket under /run/podman/, and the Docker daemon's socket at
    // /var/run/docker.sock. Reporting 'podman' here is informational —
    // routes that actually need the API will still surface the error
    // via the safe() wrapper.
    if (/\/podman\/podman\.sock$/.test(socketPath)) return 'podman';
    return 'unknown';
  }
}

// Module-scope cache for the resolved runtime. Runtime kind + socket path
// are immutable for the life of this process, and detectKind() does
// `client.version()` — which on podman shells out `dpkg-query --search` per
// helper binary (netavark, aardvark-dns, slirp4netns, crun, pasta, conmon)
// to report provenance. The doctor's probe runner fires many probes
// concurrently, each resolving the runtime, so re-detecting every time
// becomes a dpkg-query fan-out storm that pegs slow Pi-class boxes (observed
// at load 188). Cache the result; memoize the in-FLIGHT promise (not just
// the value) so a concurrent burst — the exact storm condition — collapses
// to a single version() instead of a cache stampede.
let cachedRuntime: ResolvedRuntime | null = null;
let inFlight: Promise<ResolvedRuntime | null> | null = null;

async function detectRuntimeOnce(): Promise<ResolvedRuntime | null> {
  const socketPath = await pickSocket();
  if (!socketPath) return null;
  const client = new Docker({ socketPath });
  const kind = await detectKind(client, socketPath);
  return { client, socketPath, kind };
}

export async function resolveRuntime(): Promise<ResolvedRuntime | null> {
  if (cachedRuntime) return cachedRuntime;
  if (!inFlight) {
    inFlight = detectRuntimeOnce();
  }
  const resolved = await inFlight;
  if (resolved) {
    cachedRuntime = resolved;
  }
  inFlight = null;
  return resolved;
}

/** Test-only: drop the memoized runtime so the next resolveRuntime()
 *  re-detects. */
export function __resetRuntimeCacheForTests(): void {
  cachedRuntime = null;
  inFlight = null;
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
