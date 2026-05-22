import { copyFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readLastGood } from '../quadlet/rewriter.js';
import { daemonReload, restartUnit } from '../dbus/systemd-user.js';

const QUADLET_DIR = process.env.QUADLET_DIR ?? '/quadlets';

const QUADLET_TO_UNIT: Record<string, string> = {
  'signalk-server.container': 'signalk-server.service',
  'signalk-updater-server.container': 'signalk-updater-server.service',
  'signalk-doctor-server.container': 'signalk-doctor-server.service',
};

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function restoreOne(quadletName: string, snapshotPath: string): Promise<void> {
  const target = join(QUADLET_DIR, quadletName);
  const tmp = `${target}.${process.pid}.recover.tmp`;
  await copyFile(snapshotPath, tmp);
  const { rename } = await import('node:fs/promises');
  await rename(tmp, target);
  await fsyncDir(dirname(target));
}

export interface RecoverResult {
  ok: boolean;
  restored: Array<{ quadlet: string; from: string; toTag: string }>;
  errors: string[];
}

export async function recoverAll(): Promise<RecoverResult> {
  const result: RecoverResult = { ok: true, restored: [], errors: [] };
  const lg = await readLastGood();
  if (!lg || Object.keys(lg.quadlets).length === 0) {
    result.ok = false;
    result.errors.push('no last-known-good entries on disk; nothing to restore');
    return result;
  }
  const restartUnits = new Set<string>();
  for (const [quadlet, entry] of Object.entries(lg.quadlets)) {
    try {
      await restoreOne(quadlet, entry.snapshotPath);
      result.restored.push({ quadlet, from: entry.snapshotPath, toTag: entry.tag });
      const unit = QUADLET_TO_UNIT[quadlet];
      if (unit) restartUnits.add(unit);
    } catch (err) {
      result.ok = false;
      result.errors.push(`${quadlet}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
  if (result.restored.length === 0) {
    result.ok = false;
    return result;
  }
  try {
    await daemonReload();
    for (const unit of restartUnits) {
      try {
        await restartUnit(unit);
      } catch (err) {
        result.errors.push(`restart ${unit}: ${err instanceof Error ? err.message : 'unknown'}`);
        result.ok = false;
      }
    }
  } catch (err) {
    result.errors.push(`daemon-reload: ${err instanceof Error ? err.message : 'unknown'}`);
    result.ok = false;
  }
  return result;
}

export async function recoverOne(quadletName: string): Promise<RecoverResult> {
  const result: RecoverResult = { ok: true, restored: [], errors: [] };
  const lg = await readLastGood();
  const entry = lg?.quadlets[quadletName];
  if (!entry) {
    result.ok = false;
    result.errors.push(`no last-known-good entry for ${quadletName}`);
    return result;
  }
  try {
    await restoreOne(quadletName, entry.snapshotPath);
    result.restored.push({ quadlet: quadletName, from: entry.snapshotPath, toTag: entry.tag });
    await daemonReload();
    const unit = QUADLET_TO_UNIT[quadletName];
    if (unit) await restartUnit(unit);
  } catch (err) {
    result.ok = false;
    result.errors.push(err instanceof Error ? err.message : 'unknown');
  }
  return result;
}
