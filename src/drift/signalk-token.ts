import { readFile } from 'node:fs/promises';

// Bash installer writes this file with mode 0600 after running
// `signalk-generate-token -u admin -e 5y -s ~/.signalk/security.json`.
// Doctor reads it on demand, caches the value, and reloads on failure
// (so a rotated token can be picked up without restarting the container).
const SIGNALK_TOKEN_PATH = process.env.SIGNALK_TOKEN_PATH ?? '/data/signalk-token';

let cached: string | null = null;
let cacheLoaded = false;

export async function getSignalkAdminToken(): Promise<string | null> {
  if (cacheLoaded) return cached;
  try {
    const raw = (await readFile(SIGNALK_TOKEN_PATH, 'utf8')).trim();
    cached = raw.length > 0 ? raw : null;
  } catch {
    cached = null;
  }
  cacheLoaded = true;
  return cached;
}

export function invalidateSignalkAdminTokenCache(): void {
  cached = null;
  cacheLoaded = false;
}
