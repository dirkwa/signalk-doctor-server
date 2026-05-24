import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTags } from '../ghcr.js';
import { compareSemver } from '../tagClassifier.js';

const SELF_IMAGE = process.env.SELF_IMAGE ?? 'ghcr.io/dirkwa/signalk-doctor-server';

// Same package.json read pattern as health.ts. The cached "running" version
// is what users see — it has to come from the engine's own package.json
// at boot, not from the image tag (the tag might be "latest" or a moving
// label).
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(__dirname, '..', '..', 'package.json');

let cachedCurrent = 'unknown';
async function loadCurrent(): Promise<void> {
  try {
    const raw = await readFile(PKG_PATH, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      cachedCurrent = pkg.version;
    }
  } catch {
    // leave cachedCurrent = 'unknown'
  }
}
void loadCurrent();

interface CheckUpdateResponse {
  current: string;
  latest?: string;
  updateAvailable: boolean;
  cachedAt?: string;
  /** Where to perform the actual self-update (the doctor never updates itself). */
  updateVia: string;
  error?: string;
}

const UPDATE_VIA = 'signalk-updater-server';

export async function registerSelfRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/self/check-update', async (): Promise<CheckUpdateResponse> => {
    const r = await listTags(SELF_IMAGE.replace(/^ghcr\.io\//, ''));
    if (!r.ok) {
      return {
        current: cachedCurrent,
        updateAvailable: false,
        updateVia: UPDATE_VIA,
        error: r.error.userMessage,
      };
    }
    const stable = r.tags.filter((t) => t.channel === 'stable');
    stable.sort((a, b) => compareSemver(b.name, a.name));
    const latest = stable[0]?.name;
    const updateAvailable =
      latest !== undefined &&
      cachedCurrent !== 'unknown' &&
      compareSemver(latest, cachedCurrent) > 0;
    return {
      current: cachedCurrent,
      ...(latest !== undefined ? { latest } : {}),
      updateAvailable,
      cachedAt: r.cachedAt,
      updateVia: UPDATE_VIA,
    };
  });
}
