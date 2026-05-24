import { readFile } from 'node:fs/promises';

// Bash installer writes this file with mode 0600 after running
// `signalk-generate-token -u admin -e 5y -s ~/.signalk/security.json`.
// Doctor reads it on demand, caches the value, and reloads on failure
// (so a rotated token can be picked up without restarting the container).
const SIGNALK_TOKEN_PATH = process.env.SIGNALK_TOKEN_PATH ?? '/data/signalk-token';

let cached: string | null = null;

export async function getSignalkAdminToken(): Promise<string | null> {
  // Only cache a successful, non-empty read. A failed read or empty file
  // must NOT become permanent — otherwise the bash installer racing this
  // scheduler's first scan would lock us into no-token until restart.
  if (cached !== null) return cached;
  try {
    const raw = (await readFile(SIGNALK_TOKEN_PATH, 'utf8')).trim();
    if (raw.length > 0) {
      cached = raw;
      return cached;
    }
  } catch {
    // fall through to return null
  }
  return null;
}

export function invalidateSignalkAdminTokenCache(): void {
  cached = null;
}
