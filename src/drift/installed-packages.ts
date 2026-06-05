import type { Readable } from 'node:stream';
import type Docker from 'dockerode';
import { resolveRuntime, safe } from '../podman/client.js';
import type { CategorizedError } from '../errors.js';

export interface InstalledPackage {
  name: string;
  version: string;
}

/** The set of tracked packages with their installed versions, read from
 *  the running signalk-server container's filesystem. (Replaces the old
 *  `Diagnostics` envelope that mirrored signalk-server's HTTP
 *  /skServer/diagnostics response — that endpoint is no longer consulted,
 *  so the doctor reports drift on any signalk-server image, including ones
 *  that predate it.) */
export interface InstalledPackages {
  packages: InstalledPackage[];
}

/** Why we couldn't read installed packages from the container filesystem.
 *  A getArchive read has only two failure modes worth distinguishing for
 *  the operator — the old HTTP-specific reasons (no-token, auth, http,
 *  bad-payload, not-found) are gone. */
export type InstalledPackagesReason =
  /** No container runtime at all — resolveRuntime() returned null (no
   *  podman/docker socket mounted or readable). The fix is "mount the
   *  socket", distinct from a call that errored. */
  | 'unreachable'
  /** The runtime exists but probing signalk-server's filesystem failed
   *  with a real CategorizedError (network/permission/unknown, or the
   *  signalk-server container is absent → not-found). Detail carries the
   *  categorized message. */
  | 'runtime';

export type InstalledPackagesResult =
  | { ok: true; installed: InstalledPackages }
  | { ok: false; reason: InstalledPackagesReason; detail: string };

/**
 * The fixed allow-list of packages whose installed versions the Drift scan
 * reports. This is the SAME list signalk-server's own diagnostics route
 * uses; keep it in sync with upstream:
 *   https://github.com/SignalK/signalk-server (src/diagnostics.ts, the
 *   tracked-packages array). We read these from the container filesystem
 *   rather than calling that route, so a signalk-server that predates the
 *   route still reports drift. Plugins and signalk-server itself are
 *   deliberately not tracked (matching upstream's fixed list).
 */
const TRACKED_PACKAGES = [
  '@canboat/canboatjs',
  '@canboat/ts-pgns',
  '@signalk/n2k-signalk',
  '@signalk/nmea0183-signalk',
  '@signalk/path-metadata',
  '@signalk/server-admin-ui',
  '@signalk/server-api',
  '@signalk/streams',
] as const;

const TARGET_CONTAINER = 'signalk-server';

/**
 * Leaf directories from which we ancestor-walk upward looking for
 * node_modules/<pkg>/package.json, in resolution priority order (first hit
 * wins — mirrors signalk-server's diagnostics walk, which prefers
 * configPath over appPath). Resolved at call time so tests/env can override.
 *
 * Concrete bases for the verified ghcr.io/dirkwa/signalk-server:dirkwa image
 * (and the official `_rel` layout):
 *   1. data dir (configPath): plugin/data-dir copies under <data>/node_modules.
 *   2. the signalk-server package's OWN node_modules: in the dirkwa image
 *      @signalk/* is nested there (top-level @signalk/* is pruned). Walking
 *      UP from here also reaches the hoisted top-level node_modules, so
 *      @canboat/* (and @signalk/* on _rel, where it is not pruned) resolve
 *      via the same walk.
 *   3. the install root: belt-and-suspenders for layouts where signalk-server
 *      isn't nested under its own name.
 */
function baseDirs(): string[] {
  const dataDir = process.env.SIGNALK_DOCTOR_TARGET_CONF_DIR ?? '/home/node/.signalk';
  const appDir = process.env.SIGNALK_DOCTOR_TARGET_APP_DIR ?? '/home/node/signalk';
  return [dataDir, `${appDir}/node_modules/signalk-server`, appDir];
}

/**
 * Candidate package.json absolute paths for one package name, most-specific
 * first. For each base dir we emit node_modules/<pkg>/package.json at the base
 * AND at every ancestor up to the filesystem root, so a hoisted dependency is
 * found from a nested leaf. Deduped because the base dirs share ancestors.
 */
function candidatePaths(name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const base of baseDirs()) {
    const segments = base.split('/').filter((s) => s.length > 0);
    for (let i = segments.length; i >= 0; i--) {
      const prefix = i === 0 ? '' : `/${segments.slice(0, i).join('/')}`;
      const candidate = `${prefix}/node_modules/${name}/package.json`;
      if (!seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
    }
  }
  return out;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Extract the first file entry's bytes from an uncompressed (ustar) tar.
 * getArchive returns exactly one entry (the requested package.json), so we
 * only parse the first 512-byte header + its payload. Returns null on any
 * structural surprise (short buffer, unparseable size) — callers treat null
 * as "couldn't read this package" and move on.
 */
function firstTarEntry(buf: Buffer): Buffer | null {
  if (buf.length < 512) return null;
  // ustar size field: 12 bytes at offset 124, octal ASCII, NUL/space padded.
  const sizeField = buf
    .subarray(124, 136)
    .toString('ascii')
    .replace(/[\0 ]+$/, '')
    .trim();
  if (sizeField.length === 0) return null;
  const size = parseInt(sizeField, 8);
  if (!Number.isFinite(size) || size < 0) return null;
  const end = 512 + size;
  if (end > buf.length) return null;
  return buf.subarray(512, end);
}

type FetchResult = { ok: true; value: Buffer } | { ok: false; error: CategorizedError };

/**
 * The two container operations the reader needs, behind one seam tests
 * inject a fake through (without a live container):
 *   - `probe()` confirms the signalk-server container is actually present
 *     on the resolved runtime. This is what makes a *container*-absent 404
 *     distinguishable from a *path*-absent 404 — both report "no such
 *     container - …", so without an upfront inspect a wrong/empty runtime
 *     would look like eight package misses and wrongly yield ok:[].
 *   - `fetch(path)` reads one package.json's tar bytes via getArchive.
 */
export interface ContainerProbe {
  probe: () => Promise<FetchResult>;
  fetch: (path: string) => Promise<FetchResult>;
}

function dockerodeProbe(container: Docker.Container): ContainerProbe {
  return {
    probe: () => safe(() => container.inspect().then(() => Buffer.alloc(0))),
    fetch: (path) =>
      // @types/dockerode types getArchive's options as `{}`; the runtime
      // accepts `{ path }`, so cast the option object (not the result).
      safe(() =>
        container
          .getArchive({ path } as unknown as Record<string, never>)
          .then((s) => streamToBuffer(s as unknown as Readable)),
      ),
  };
}

type ReadOne =
  | { kind: 'found'; version: string }
  | { kind: 'absent' }
  | { kind: 'error'; detail: string };

async function readPackageVersion(probe: ContainerProbe, name: string): Promise<ReadOne> {
  for (const path of candidatePaths(name)) {
    const res = await probe.fetch(path);
    if (res.ok) {
      const entry = firstTarEntry(res.value);
      if (!entry) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.toString('utf8'));
      } catch {
        continue; // malformed package.json — try the next candidate
      }
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version.length > 0) {
        return { kind: 'found', version };
      }
      continue; // no usable version field — keep walking
    }
    // not-found here means this candidate PATH doesn't exist (the container
    // itself was already proven present by probe()); that's the normal
    // ancestor-walk miss, so keep walking. Any other categorized error is a
    // real runtime failure we must not mistake for "absent".
    if (res.error.kind === 'not-found') continue;
    return { kind: 'error', detail: `${res.error.kind}: ${res.error.userMessage}` };
  }
  return { kind: 'absent' };
}

/**
 * Read the installed versions of the tracked packages from the running
 * signalk-server container's filesystem. Drop-in replacement for the old
 * HTTP fetchDiagnostics(): same { packages } success shape, no token, no
 * signalk-server HTTP route required.
 *
 * `probe` is injectable for tests; in production it resolves the podman
 * runtime and reads from the signalk-server container.
 */
export async function readInstalledPackages(
  probe?: ContainerProbe,
): Promise<InstalledPackagesResult> {
  let target = probe;
  if (!target) {
    const rt = await resolveRuntime();
    if (!rt) {
      return { ok: false, reason: 'unreachable', detail: 'no container runtime socket available' };
    }
    target = dockerodeProbe(rt.client.getContainer(TARGET_CONTAINER));
  }

  // Prove the container is present BEFORE walking package paths. A
  // container-absent runtime answers every getArchive with the same
  // "no such container" 404 that a path-miss produces, so without this
  // inspect a wrong/empty runtime would look like eight package misses and
  // wrongly return ok:[]. A failed probe is the honest unreachable signal —
  // the scanner then keeps the prior packages instead of zeroing them.
  const reachable = await target.probe();
  if (!reachable.ok) {
    return {
      ok: false,
      reason: 'runtime',
      detail: `${reachable.error.kind}: cannot reach ${TARGET_CONTAINER} (${reachable.error.userMessage})`,
    };
  }

  const packages: InstalledPackage[] = [];
  let firstRuntimeError: string | null = null;
  for (const name of TRACKED_PACKAGES) {
    const r = await readPackageVersion(target, name);
    if (r.kind === 'error') {
      // The container is reachable (probe succeeded), so a per-path runtime
      // error is usually a transient glitch on one package — omit it and keep
      // going for partial success. But remember the first one: if it turns out
      // EVERY read failed (e.g. a permission/socket fault that the inspect
      // probe didn't hit), we must not return an empty ok:[] that looks like a
      // healthy image with no packages and zeroes the prior data.
      if (firstRuntimeError === null) firstRuntimeError = r.detail;
      continue;
    }
    if (r.kind === 'found') packages.push({ name, version: r.version });
  }

  // Zero packages with a runtime error means every read failed — report it so
  // the scanner keeps the prior packages. Zero packages with no error is a
  // genuine (if alarming) "image ships none of the tracked packages" and stays
  // ok; the webapp's empty-state message surfaces that.
  if (packages.length === 0 && firstRuntimeError !== null) {
    return { ok: false, reason: 'runtime', detail: firstRuntimeError };
  }

  return { ok: true, installed: { packages } };
}
