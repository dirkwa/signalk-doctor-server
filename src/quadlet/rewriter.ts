import { open, mkdir, readFile, rename, copyFile, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

const QUADLET_DIR = process.env.QUADLET_DIR ?? '/quadlets';
// Inside the doctor container the doctor's data dir is /data; from the updater
// it's mounted as /doctor-data. Both honor the env override.
const DOCTOR_DATA = process.env.DOCTOR_DATA ?? '/data';
const SNAPSHOT_DIR = join(DOCTOR_DATA, 'snapshots');
const LAST_GOOD_PATH = join(DOCTOR_DATA, 'last-good.json');

export interface LastGood {
  updatedAt: string;
  quadlets: Record<string, { tag: string; image: string; snapshotPath: string }>;
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeAtomic(filePath: string, body: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.write(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, filePath);
  await fsyncDir(dirname(filePath));
}

export async function ensureDirs(): Promise<void> {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
}

export async function readQuadlet(quadletName: string): Promise<string> {
  return (await readFile(join(QUADLET_DIR, quadletName), 'utf8')).toString();
}

export async function snapshotQuadlet(quadletName: string): Promise<string> {
  await ensureDirs();
  const src = join(QUADLET_DIR, quadletName);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snap = join(SNAPSHOT_DIR, `${ts}-${quadletName}`);
  await copyFile(src, snap);
  return snap;
}

export async function pruneSnapshots(quadletName: string, keep = 10): Promise<void> {
  await ensureDirs();
  const all = (await readdir(SNAPSHOT_DIR))
    .filter((n) => n.endsWith(`-${quadletName}`))
    .map((n) => join(SNAPSHOT_DIR, n));
  if (all.length <= keep) return;
  const withMtime: Array<{ p: string; m: number }> = [];
  for (const p of all) {
    const s = await stat(p);
    withMtime.push({ p, m: s.mtimeMs });
  }
  withMtime.sort((a, b) => b.m - a.m);
  for (const { p } of withMtime.slice(keep)) {
    try {
      await unlink(p);
    } catch {
      // best-effort
    }
  }
}

/**
 * Rewrite a single `Image=` line in a Quadlet file with a new tag.
 * Preserves the image base; only swaps the tag portion (text after the last `:`).
 *
 * Returns the previous image string for rollback.
 */
export function rewriteImageLine(
  body: string,
  newImage: string,
): { body: string; previous: string } {
  const lines = body.split('\n');
  let previous = '';
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (/^Image\s*=/i.test(trimmed) && !found) {
      const m = line.match(/^(\s*)Image\s*=\s*(.*)$/i);
      if (m && m[2] !== undefined) {
        previous = m[2].trim();
        lines[i] = `${m[1] ?? ''}Image=${newImage}`;
        found = true;
      }
    }
  }
  if (!found) throw new Error('Image= line not found in Quadlet');
  return { body: lines.join('\n'), previous };
}

export async function rewriteQuadletImage(
  quadletName: string,
  newImage: string,
): Promise<{ snapshotPath: string; previousImage: string }> {
  const filePath = join(QUADLET_DIR, quadletName);
  const original = await readQuadlet(quadletName);
  const snapshotPath = await snapshotQuadlet(quadletName);
  const { body, previous } = rewriteImageLine(original, newImage);
  await writeAtomic(filePath, body);
  await pruneSnapshots(quadletName);
  return { snapshotPath, previousImage: previous };
}

export async function readLastGood(): Promise<LastGood | null> {
  try {
    const body = await readFile(LAST_GOOD_PATH, 'utf8');
    return JSON.parse(body.toString()) as LastGood;
  } catch {
    return null;
  }
}

export async function writeLastGood(
  quadletName: string,
  entry: { tag: string; image: string; snapshotPath: string },
): Promise<void> {
  await mkdir(DOCTOR_DATA, { recursive: true });
  const existing = (await readLastGood()) ?? { updatedAt: '', quadlets: {} };
  existing.quadlets[quadletName] = entry;
  existing.updatedAt = new Date().toISOString();
  await writeAtomic(LAST_GOOD_PATH, JSON.stringify(existing, null, 2));
}

export function pathFor(quadletName: string): string {
  return join(QUADLET_DIR, quadletName);
}

export function snapshotDir(): string {
  return SNAPSHOT_DIR;
}

export { basename };
