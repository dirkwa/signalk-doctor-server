import type { FastifyRequest, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';

// Resolved at request time so tests can swap the path between server
// instances. The cache key is also the path, so a rotated path drops the
// cached token (otherwise rotation would silently keep accepting the
// previous file's value).
function tokenPath(): string {
  return process.env.TOKEN_PATH ?? '/data/token';
}

let cachedToken: string | null = null;
let cachedFromPath: string | null = null;

async function loadToken(): Promise<string | null> {
  const path = tokenPath();
  if (cachedToken && cachedFromPath === path) return cachedToken;
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    if (raw.length > 0) {
      cachedToken = raw;
      cachedFromPath = path;
      return raw;
    }
  } catch {
    // missing token file is fine — auth then rejects everything
  }
  return null;
}

function extractToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  const xauth = req.headers['x-sk-auth'];
  if (typeof xauth === 'string' && xauth.length > 0) return xauth.trim();
  return null;
}

export async function requireToken(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = await loadToken();
  if (!expected) {
    reply.code(503).send({ error: 'auth not initialized: token file missing' });
    return;
  }
  const got = extractToken(req);
  if (got !== expected) {
    reply.code(401).send({ error: 'unauthorized' });
  }
}

export function __resetTokenCacheForTests(): void {
  cachedToken = null;
  cachedFromPath = null;
}
