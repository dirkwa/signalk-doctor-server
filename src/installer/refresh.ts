import { open, mkdir, copyFile, readFile, stat, access, constants, rename } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { createHash } from 'node:crypto';

// GitHub Pages base for the installer payload. Resolved at request time so
// tests can swap PAGES_BASE without touching code. Mirrors the same source
// the host bash one-liner uses (curl … github.io/signalk-universal-installer/…).
const PAGES_BASE_DEFAULT = 'https://dirkwa.github.io/signalk-universal-installer';

// Inside the container the doctor's data dir is /data; host scripts are
// reachable at /host-bin (new mount added by the matching installer-repo PR).
// Quadlet templates are written to a payload dir under /data so the next
// install run (or a future "apply Quadlet refresh" feature) can read them
// without re-fetching. Honor env overrides so unit tests don't need root.
// Resolved lazily on each request so tests can swap DOCTOR_DATA /
// HOST_BIN_DIR between cases without re-importing the module. Production
// callers see the same constants every invocation because the env vars
// don't change after the systemd-user unit starts.
function doctorData(): string {
  return process.env.DOCTOR_DATA ?? '/data';
}
function hostBinDir(): string {
  return process.env.HOST_BIN_DIR ?? '/host-bin';
}
function snapshotDir(): string {
  return join(doctorData(), 'installer-snapshots');
}
function payloadDir(): string {
  return join(doctorData(), 'installer-payload');
}

// One descriptor per artifact the refresh fetches + writes. Keeping this
// table-driven means the "what got refreshed" summary the route returns is
// derived from the same source the writer iterates — they can't drift.
export type ArtifactKind = 'host-script' | 'quadlet-template' | 'detect-script';

export interface ArtifactDescriptor {
  /** Stable identifier surfaced in the API response. */
  id: string;
  /** Path under https://dirkwa.github.io/signalk-universal-installer/. */
  remotePath: string;
  /** Local destination inside the doctor container. */
  destPath: string;
  /** Octal mode for the write (0o755 for executable scripts, 0o644 for templates). */
  mode: number;
  kind: ArtifactKind;
}

// Built lazily for the same reason hostBinDir() / doctorData() are functions:
// destination paths must reflect the current env at call time so tests can
// point them at a tmp dir.
function artifacts(): ArtifactDescriptor[] {
  const hb = hostBinDir();
  const pd = payloadDir();
  return [
    {
      // signalk.tmpl's __SK_VERSION__ placeholder is substituted upstream by
      // the signalk-universal-installer Pages workflow at deploy time, so
      // the body we fetch already has the real installer version baked in.
      // No doctor-side substitution needed.
      id: 'signalk',
      remotePath: 'installer/linux/signalk.tmpl',
      destPath: join(hb, 'signalk'),
      mode: 0o755,
      kind: 'host-script',
    },
    {
      id: 'signalk-recovery',
      remotePath: 'installer/linux/signalk-recovery.tmpl',
      destPath: join(hb, 'signalk-recovery'),
      mode: 0o755,
      kind: 'host-script',
    },
    {
      // Pi CAN-HAT detect-and-advise helper shipped by the
      // signalk-universal-installer (PR #72). Like signalk-recovery, it
      // has no __…__ placeholders, so the doctor writes it byte-for-byte
      // from Pages — no `substitute` field.
      id: 'signalk-socketcan',
      remotePath: 'installer/linux/signalk-socketcan.tmpl',
      destPath: join(hb, 'signalk-socketcan'),
      mode: 0o755,
      kind: 'host-script',
    },
    {
      // BLE / D-Bus passthrough helper (installer PR #173). Same shape as
      // signalk-socketcan: no placeholders, written byte-for-byte to the
      // host PATH so `signalk bluetooth` works after a refresh without
      // re-running the bash installer.
      id: 'signalk-bluetooth',
      remotePath: 'installer/linux/signalk-bluetooth.tmpl',
      destPath: join(hb, 'signalk-bluetooth'),
      mode: 0o755,
      kind: 'host-script',
    },
    {
      id: 'detect-hardware',
      // The detect-hardware script is fetched but not invoked by the doctor —
      // it needs host devices (/dev/serial/by-id, /proc/device-tree/model, the
      // system DBus) that the doctor container does not mount. Operators run
      // it from the host via `signalk detect-hardware` (planned) or by
      // re-running the bash installer. We still refresh the script so that
      // when the host side gets around to invoking it, it's the current
      // version. Lives under payloadDir() rather than hostBinDir() because
      // it sits in the installer's lib path, not on the user's PATH.
      remotePath: 'installer/linux/detect-hardware.sh',
      destPath: join(pd, 'detect-hardware.sh'),
      mode: 0o755,
      kind: 'detect-script',
    },
    {
      id: 'quadlet-signalk-server',
      remotePath: 'quadlets/signalk-server.container.template',
      destPath: join(pd, 'signalk-server.container.template'),
      mode: 0o644,
      kind: 'quadlet-template',
    },
    {
      id: 'quadlet-updater-server',
      remotePath: 'quadlets/signalk-updater-server.container.template',
      destPath: join(pd, 'signalk-updater-server.container.template'),
      mode: 0o644,
      kind: 'quadlet-template',
    },
    {
      id: 'quadlet-doctor-server',
      remotePath: 'quadlets/signalk-doctor-server.container.template',
      destPath: join(pd, 'signalk-doctor-server.container.template'),
      mode: 0o644,
      kind: 'quadlet-template',
    },
    {
      // dbus-auth-proxy sidecar for BLE passthrough (installer PR #173).
      // Staged like the other templates — the doctor never applies it;
      // the bash installer (or a future apply flow) consumes the payload.
      id: 'quadlet-dbus-proxy',
      remotePath: 'quadlets/signalk-dbus-proxy.container.template',
      destPath: join(pd, 'signalk-dbus-proxy.container.template'),
      mode: 0o644,
      kind: 'quadlet-template',
    },
  ];
}

export type ArtifactStatus =
  'updated' | 'unchanged' | 'mount-missing' | 'fetch-failed' | 'write-failed';

export interface ArtifactResult {
  id: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  /** SHA-256 of the bytes that ended up at destPath. */
  sha256?: string;
  /** Snapshot path of the prior content, when one existed. */
  snapshotPath?: string;
  /** Human-readable detail for non-success statuses. */
  message?: string;
}

export interface RefreshSummary {
  startedAt: string;
  finishedAt: string;
  pagesBase: string;
  results: ArtifactResult[];
  counts: Record<ArtifactStatus, number>;
}

function pagesBase(): string {
  return process.env.INSTALLER_PAGES_BASE ?? PAGES_BASE_DEFAULT;
}

function sha256(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeAtomicWithMode(filePath: string, body: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', mode);
  try {
    await fh.write(body);
    await fh.sync();
    // chmod on the open handle to guarantee the mode even if umask
    // would otherwise mask the bits requested at open().
    await fh.chmod(mode);
  } finally {
    await fh.close();
  }
  await rename(tmp, filePath);
  await fsyncDir(dirname(filePath));
}

async function snapshotIfExists(filePath: string): Promise<string | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  await mkdir(snapshotDir(), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snap = join(snapshotDir(), `${ts}-${basename(filePath)}`);
  await copyFile(filePath, snap);
  return snap;
}

async function fetchArtifact(remotePath: string): Promise<Buffer> {
  const url = `${pagesBase()}/${remotePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} → HTTP ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function refreshOne(descriptor: ArtifactDescriptor): Promise<ArtifactResult> {
  // Host-script destinations live under hostBinDir(). If that mount is
  // absent the dest's parent dir doesn't exist and the operator's installer
  // is still the bash floor — surface this clearly rather than erroring out
  // the whole refresh.
  if (descriptor.kind === 'host-script') {
    const hb = hostBinDir();
    if (!(await pathExists(hb))) {
      return {
        id: descriptor.id,
        kind: descriptor.kind,
        status: 'mount-missing',
        message: `${hb} is not mounted; rerun the bash installer to add the host-bin bind mount, then retry.`,
      };
    }
  }

  let body: Buffer;
  try {
    body = await fetchArtifact(descriptor.remotePath);
  } catch (err) {
    return {
      id: descriptor.id,
      kind: descriptor.kind,
      status: 'fetch-failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const newHash = sha256(body);

  // Unchanged short-circuit. Avoids unnecessary snapshots when the operator
  // hits "refresh" twice in a row, and keeps the snapshot dir from filling
  // with identical copies.
  if (await pathExists(descriptor.destPath)) {
    const current = await readFile(descriptor.destPath);
    if (sha256(current) === newHash) {
      return { id: descriptor.id, kind: descriptor.kind, status: 'unchanged', sha256: newHash };
    }
  }

  const snapshotPath = await snapshotIfExists(descriptor.destPath);
  try {
    await writeAtomicWithMode(descriptor.destPath, body, descriptor.mode);
  } catch (err) {
    return {
      id: descriptor.id,
      kind: descriptor.kind,
      status: 'write-failed',
      message: err instanceof Error ? err.message : String(err),
      snapshotPath,
    };
  }
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    status: 'updated',
    sha256: newHash,
    snapshotPath,
  };
}

export async function refreshInstaller(): Promise<RefreshSummary> {
  const startedAt = new Date().toISOString();
  const results: ArtifactResult[] = [];
  for (const a of artifacts()) {
    results.push(await refreshOne(a));
  }
  const counts: Record<ArtifactStatus, number> = {
    updated: 0,
    unchanged: 0,
    'mount-missing': 0,
    'fetch-failed': 0,
    'write-failed': 0,
  };
  for (const r of results) counts[r.status]++;
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    pagesBase: pagesBase(),
    results,
    counts,
  };
}

export interface InstallerStatus {
  hostBinMounted: boolean;
  pagesBase: string;
  artifacts: Array<{
    id: string;
    kind: ArtifactKind;
    destPath: string;
    present: boolean;
    sha256?: string;
    mtime?: string;
  }>;
}

export async function readInstallerStatus(): Promise<InstallerStatus> {
  const hostBinMounted = await pathExists(hostBinDir());
  const out: InstallerStatus['artifacts'] = [];
  for (const a of artifacts()) {
    const present = await pathExists(a.destPath);
    let hash: string | undefined;
    let mtime: string | undefined;
    if (present) {
      try {
        const body = await readFile(a.destPath);
        hash = sha256(body);
        const st = await stat(a.destPath);
        mtime = new Date(st.mtimeMs).toISOString();
      } catch {
        // best-effort — if we can't read it, just report present without
        // hash/mtime rather than failing the status call.
      }
    }
    out.push({
      id: a.id,
      kind: a.kind,
      destPath: a.destPath,
      present,
      sha256: hash,
      mtime,
    });
  }
  return { hostBinMounted, pagesBase: pagesBase(), artifacts: out };
}
