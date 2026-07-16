import type { Readable } from 'node:stream';
import type Docker from 'dockerode';
import { resolveRuntime, safe } from '../podman/client.js';
import type { CategorizedError } from '../errors.js';

/** One tracked package with its version at each of the two locations a copy
 *  can live in. At least one of the two is non-null (a package absent from
 *  both locations is omitted from the result entirely). */
export interface InstalledPackage {
  name: string;
  /** Version in the server's own app tree — the copy the image ships and
   *  the server core loads. Null when the image doesn't carry the package. */
  image: string | null;
  /** Version in the data dir's plugin tree (`<configPath>/node_modules`) —
   *  npm-installed there as a dependency of the user's plugins and loaded by
   *  those plugins. Null when no data-dir copy exists. */
  dataDir: string | null;
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

function dataDirRoot(): string {
  return process.env.SIGNALK_DOCTOR_TARGET_CONF_DIR ?? '/home/node/.signalk';
}
function appDirRoot(): string {
  return process.env.SIGNALK_DOCTOR_TARGET_APP_DIR ?? '/home/node/signalk';
}

/**
 * Candidate package.json path for the DATA-DIR copy of one package: exactly
 * `<configPath>/node_modules/<pkg>/package.json`, where signalk-server's
 * appstore npm-installs the user's plugins (and npm hoists their shared
 * dependencies). No ancestor walk — walking up from the data dir would leave
 * the user's tree and misattribute an app-tree copy as a user install.
 */
function dataDirCandidatePaths(name: string): string[] {
  return [`${dataDirRoot()}/node_modules/${name}/package.json`];
}

/**
 * Candidate package.json absolute paths for the IMAGE (app-tree) copy of one
 * package, most-specific first. Leaf directories we ancestor-walk upward from,
 * for the verified ghcr.io/dirkwa/signalk-server:dirkwa image (and the
 * official `_rel` layout):
 *   1. the signalk-server package's OWN node_modules: in the dirkwa image
 *      @signalk/* is nested there (top-level @signalk/* is pruned). Walking
 *      UP from here also reaches the hoisted top-level node_modules, so
 *      @canboat/* (and @signalk/* on _rel, where it is not pruned) resolve
 *      via the same walk.
 *   2. the install root: belt-and-suspenders for layouts where signalk-server
 *      isn't nested under its own name.
 * For each base dir we emit node_modules/<pkg>/package.json at the base AND
 * at every ancestor up to the filesystem root, so a hoisted dependency is
 * found from a nested leaf. Deduped because the base dirs share ancestors.
 * The walk stops before it would reach the data dir's own tree only because
 * the data dir is not an ancestor of the app dir in any supported layout.
 */
function imageCandidatePaths(name: string): string[] {
  const appDir = appDirRoot();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const base of [`${appDir}/node_modules/signalk-server`, appDir]) {
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
  { kind: 'found'; version: string } | { kind: 'absent' } | { kind: 'error'; detail: string };

async function readVersionAt(probe: ContainerProbe, candidates: string[]): Promise<ReadOne> {
  for (const path of candidates) {
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
    return { kind: 'error', detail: describeReadError(res.error) };
  }
  return { kind: 'absent' };
}

/** The signature podman/crun emits when the rootless API service is in a
 *  DIFFERENT user namespace than the container it's asked to read from: it
 *  cannot open the container's mount namespace. This is not a real
 *  socket/mount-permission problem — it's a stale podman service namespace,
 *  fixed by restarting the service so it rejoins the containers' pause
 *  namespace. We detect it from the raw error so the operator gets the actual
 *  remedy instead of the generic "check socket and mount permissions" (which
 *  sends them chasing the wrong thing — the socket is fine, a shell
 *  `podman exec` on the same file works). */
function isStaleApiNamespaceError(raw: string): boolean {
  return /\/proc\/\d+\/ns\/mnt/i.test(raw) && /permission denied/i.test(raw);
}

/** Build the operator-facing detail for a failed container read. For the
 *  stale-namespace case, replace the misleading generic message with the
 *  precise remedy; otherwise surface kind + userMessage plus the raw error
 *  (truncated) so a field report names the actual failure. */
function describeReadError(error: CategorizedError): string {
  if (error.kind === 'permission' && isStaleApiNamespaceError(error.raw)) {
    return (
      'permission: the podman API service is in a stale user namespace and ' +
      "cannot read signalk-server's files (a shell `podman exec` still works). " +
      'Fix: `systemctl --user restart podman.service`, then restart this ' +
      'container. Re-running the installer also repairs it.'
    );
  }
  return `${error.kind}: ${error.userMessage} (${truncateRaw(error.raw)})`;
}

/** Trim a raw error message to a sane length for the operator-facing detail
 *  and collapse whitespace so a multi-line stderr stays one tidy line. */
function truncateRaw(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}…` : oneLine;
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
      detail: `${reachable.error.kind}: cannot reach ${TARGET_CONTAINER} (${reachable.error.userMessage}) (${truncateRaw(reachable.error.raw)})`,
    };
  }

  const packages: InstalledPackage[] = [];
  let firstRuntimeError: string | null = null;
  for (const name of TRACKED_PACKAGES) {
    // Each location is looked up independently so a copy in the user's
    // plugin tree can never shadow (or be shadowed by) the image's copy —
    // the two drift for different reasons and heal through different paths.
    const dataDir = await readVersionAt(target, dataDirCandidatePaths(name));
    const image = await readVersionAt(target, imageCandidatePaths(name));
    if (dataDir.kind === 'error' || image.kind === 'error') {
      // The container is reachable (probe succeeded), so a per-path runtime
      // error is usually a transient glitch on one package — omit it and keep
      // going for partial success. But remember the first one: if it turns out
      // EVERY read failed (e.g. a permission/socket fault that the inspect
      // probe didn't hit), we must not return an empty ok:[] that looks like a
      // healthy image with no packages and zeroes the prior data.
      const detail = dataDir.kind === 'error' ? dataDir.detail : null;
      const imageDetail = image.kind === 'error' ? image.detail : null;
      if (firstRuntimeError === null) firstRuntimeError = detail ?? imageDetail;
      continue;
    }
    if (dataDir.kind === 'found' || image.kind === 'found') {
      packages.push({
        name,
        image: image.kind === 'found' ? image.version : null,
        dataDir: dataDir.kind === 'found' ? dataDir.version : null,
      });
    }
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
