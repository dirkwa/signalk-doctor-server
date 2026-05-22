import { describe, it, expect } from 'vitest';
import { createServer } from '../src/server.js';

describe('GET /api/health', () => {
  it('returns ok + runtime shape', async () => {
    const app = await createServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; runtime: string; uptimeSeconds: number };
      expect(typeof body.ok).toBe('boolean');
      expect(['podman', 'docker', 'unknown']).toContain(body.runtime);
      expect(typeof body.uptimeSeconds).toBe('number');
    } finally {
      await app.close();
    }
  });
});
