import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeResult } from './types.js';
import { resolveRuntime } from '../podman/client.js';

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

async function readRunningImage(name: string): Promise<string | null> {
  const rt = await resolveRuntime();
  if (!rt) return null;
  try {
    const info = (await rt.client.getContainer(name).inspect()) as unknown as {
      Image?: string;
      ImageName?: string;
      Config?: { Image?: string };
    };
    return info.ImageName ?? info.Config?.Image ?? info.Image ?? null;
  } catch {
    return null;
  }
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
  const [quadletImage, runningImage, reportedVersion] = await Promise.all([
    readQuadletImage(quadletName),
    readRunningImage(containerName),
    healthUrl ? readReportedVersion(healthUrl) : Promise.resolve<string | null>(null),
  ]);
  return {
    quadletImage,
    quadletTag: tagOf(quadletImage),
    runningImage,
    runningTag: tagOf(runningImage),
    reportedVersion,
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
  const okSummaries: string[] = [];
  const details: Record<string, unknown> = {};

  for (const r of results) {
    details[r.container] = r.sources;
    const { quadletTag, runningTag, reportedVersion } = r.sources;
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
      message: driftMessages.join('; '),
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
