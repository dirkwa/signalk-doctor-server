import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthResponse } from '../types.js';
import { resolveRuntime } from '../podman/client.js';

const startedAt = Date.now();

// Resolve the engine container's own package.json from dist/routes/
// (this file at runtime). We cache the version once at module load so
// /api/health stays a cheap call. Falls back to "unknown" if the read
// fails — the route still answers, the version just shows up empty in
// the UI rather than blocking healthcheck.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(__dirname, '..', '..', 'package.json');

let cachedVersion = 'unknown';
async function loadVersion(): Promise<void> {
  try {
    const raw = await readFile(PKG_PATH, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      cachedVersion = pkg.version;
    }
  } catch {
    // leave cachedVersion = 'unknown'
  }
}
void loadVersion();

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (): Promise<HealthResponse> => {
    const runtime = await resolveRuntime();
    return {
      ok: runtime !== null,
      runtime: runtime?.kind ?? 'unknown',
      socketPath: runtime?.socketPath,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      version: cachedVersion,
    };
  });
}
