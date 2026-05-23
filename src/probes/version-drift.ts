import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeResult } from './types.js';
import { resolveRuntime, safe } from '../podman/client.js';
import type { CategorizedError } from '../errors.js';

// Resolve these at request time, not module-load, so tests can swap
// them via process.env between probe runs and so the installer can
// override either via the engine's Quadlet without rebuilding.
function quadletDir(): string {
  return process.env.QUADLET_DIR ?? '/quadlets';
}
function updaterUrl(): string {
  return process.env.UPDATER_URL ?? 'http://host.containers.internal:3003/api/health';
}

interface Sources {
  /** Image= line value from the Quadlet, e.g. ghcr.io/foo/bar:0.5.0. */
  quadletImage: string | null;
  /** Tag suffix extracted from quadletImage, e.g. "0.5.0". */
  quadletTag: string | null;
  /** Image string the container is actually running, from dockerode inspect. */
  runningImage: string | null;
  /** Tag suffix extracted from runningImage. */
  runningTag: string | null;
  /** package.json version reported by the engine itself (only the updater
   *  exposes one — null for signalk-server). */
  reportedVersion: string | null;
  /** Categorized error from the dockerode inspect call. Null on
   *  success or on the benign "container not found" case (already
   *  reflected in runningImage=null). Set to a CategorizedError for
   *  network / auth / permission failures so the probe surfaces them
   *  instead of silently degrading to "no version information". */
  runtimeError: CategorizedError | null;
}

function tagOf(image: string | null): string | null {
  if (!image) return null;
  // Strip optional @sha256:… digest first, then take after the last colon.
  const noDigest = image.split('@')[0];
  const colon = noDigest.lastIndexOf(':');
  // Guard against IPv6-shaped registry prefixes (no current path uses them,
  // but `:` may also appear in the registry host like host:5000/foo:tag).
  // The tag is always after the LAST slash + colon if a slash exists.
  const lastSlash = noDigest.lastIndexOf('/');
  if (colon > lastSlash && colon >= 0) return noDigest.slice(colon + 1);
  return null;
}

async function readQuadletImage(quadletName: string): Promise<string | null> {
  try {
    const path = join(quadletDir(), quadletName);
    const text = await readFile(path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Image=')) return trimmed.slice('Image='.length).trim();
    }
    return null;
  } catch {
    return null;
  }
}

interface RunningImageResult {
  image: string | null;
  /** Categorized error from the dockerode inspect. Null on success or
   *  on the "container not found" path (which we treat as "no info
   *  yet" rather than a failure to surface). */
  error: CategorizedError | null;
}

async function readRunningImage(name: string): Promise<RunningImageResult> {
  const rt = await resolveRuntime();
  if (!rt) return { image: null, error: null };
  const result = await safe(() => rt.client.getContainer(name).inspect());
  if (!result.ok) {
    // "not-found" is the benign "this peer isn't installed yet" path
    // (e.g. fresh boat with only signalk-server). Everything else
    // (network / auth / permission / unknown) is real and should
    // surface up to the probe message so a user knows the doctor
    // couldn't read the runtime state.
    if (result.error.kind === 'not-found') {
      return { image: null, error: null };
    }
    return { image: null, error: result.error };
  }
  const info = result.value as unknown as {
    Image?: string;
    ImageName?: string;
    Config?: { Image?: string };
  };
  return {
    image: info.ImageName ?? info.Config?.Image ?? info.Image ?? null,
    error: null,
  };
}

async function readReportedVersion(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: string };
      return body.version && body.version !== 'unknown' ? body.version : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

async function gatherSources(
  containerName: string,
  quadletName: string,
  healthUrl: string | null,
): Promise<Sources> {
  const [quadletImage, running, reportedVersion] = await Promise.all([
    readQuadletImage(quadletName),
    readRunningImage(containerName),
    healthUrl ? readReportedVersion(healthUrl) : Promise.resolve<string | null>(null),
  ]);
  return {
    quadletImage,
    quadletTag: tagOf(quadletImage),
    runningImage: running.image,
    runningTag: tagOf(running.image),
    reportedVersion,
    runtimeError: running.error,
  };
}

/**
 * Detect version drift between three sources of truth: the Quadlet
 * `Image=` line, the dockerode-reported running image, and (for the
 * updater) the engine's own `/api/health.version` from inside the
 * container.
 *
 * Three drift modes worth flagging:
 *   1. Quadlet tag != running container tag — happens when a user
 *      manually `podman pull`ed a new tag or auto-recreate hasn't
 *      caught up yet.
 *   2. Engine-reported version != running container tag — hand-built
 *      image where the tag and package.json version disagree.
 *   3. Engine-reported version != Quadlet tag — already covered by (1)
 *      and (2) but worth surfacing if (1) is silent (rare).
 */
export async function probeVersionDrift(): Promise<ProbeResult> {
  const t0 = Date.now();
  const targets: Array<{ container: string; quadlet: string; healthUrl: string | null }> = [
    {
      container: 'signalk-updater-server',
      quadlet: 'signalk-updater-server.container',
      healthUrl: updaterUrl(),
    },
    {
      container: 'signalk-server',
      quadlet: 'signalk-server.container',
      // signalk-server doesn't expose package.json via its own HTTP API,
      // so we only compare Quadlet vs. running for it.
      healthUrl: null,
    },
  ];

  const results = await Promise.all(
    targets.map(async (t) => ({
      ...t,
      sources: await gatherSources(t.container, t.quadlet, t.healthUrl),
    })),
  );

  const driftMessages: string[] = [];
  const runtimeWarnings: string[] = [];
  const okSummaries: string[] = [];
  const details: Record<string, unknown> = {};

  for (const r of results) {
    details[r.container] = r.sources;
    const { quadletTag, runningTag, reportedVersion, runtimeError } = r.sources;
    // CC-6: a real runtime error (network/auth/permission/unknown)
    // means we can't trust runningTag = null as "no container", so
    // surface the categorized userMessage instead of silently
    // declaring no-drift.
    if (runtimeError) {
      runtimeWarnings.push(
        `${r.container}: cannot read running image (${runtimeError.kind}: ${runtimeError.userMessage})`,
      );
      continue;
    }
    if (quadletTag && runningTag && quadletTag !== runningTag) {
      driftMessages.push(
        `${r.container}: Quadlet pins ${quadletTag} but container is on ${runningTag}`,
      );
      continue;
    }
    if (reportedVersion && runningTag && reportedVersion !== runningTag) {
      driftMessages.push(
        `${r.container}: image tag ${runningTag} but engine reports v${reportedVersion}`,
      );
      continue;
    }
    if (reportedVersion && quadletTag && reportedVersion !== quadletTag) {
      driftMessages.push(
        `${r.container}: Quadlet pins ${quadletTag} but engine reports v${reportedVersion}`,
      );
      continue;
    }
    // No drift detected; emit a one-line summary for the details pane.
    const stamp = reportedVersion ? `v${reportedVersion}` : (runningTag ?? quadletTag ?? 'unknown');
    okSummaries.push(`${r.container}: ${stamp}`);
  }

  if (driftMessages.length > 0) {
    return {
      id: 'version-drift',
      label: 'Version drift',
      status: 'warn',
      message: [...driftMessages, ...runtimeWarnings].join('; '),
      details,
      durationMs: Date.now() - t0,
    };
  }

  // Runtime errors without a drift verdict are still worth surfacing —
  // they mean "we couldn't tell." Warn instead of ok so the user
  // notices the probe didn't complete its check.
  if (runtimeWarnings.length > 0) {
    return {
      id: 'version-drift',
      label: 'Version drift',
      status: 'warn',
      message: runtimeWarnings.join('; '),
      details,
      durationMs: Date.now() - t0,
    };
  }

  return {
    id: 'version-drift',
    label: 'Version drift',
    status: 'ok',
    message:
      okSummaries.length > 0
        ? `All sources agree: ${okSummaries.join(', ')}`
        : 'No version information available to compare',
    details,
    durationMs: Date.now() - t0,
  };
}
