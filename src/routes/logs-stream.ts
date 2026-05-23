import type { FastifyInstance, FastifyReply } from 'fastify';
import { getOrCreateBroker } from '../log-stream-broker.js';

const HEARTBEAT_MS = 15000;

// Per-container max history kept in-broker so a freshly attaching SSE
// client can be served the recent past without spawning a second
// follow-stream against the daemon. Bounded so a noisy container
// (signalk-server logs at WARN ~ 1/s; INFO bursts hit 100/s) never
// pegs memory.
const BACKFILL_LIMIT = 500;

const containerHistory = new Map<string, string[]>();

function pushHistory(name: string, line: string): void {
  let buf = containerHistory.get(name);
  if (!buf) {
    buf = [];
    containerHistory.set(name, buf);
  }
  buf.push(line);
  if (buf.length > BACKFILL_LIMIT) buf.splice(0, buf.length - BACKFILL_LIMIT);
}

function getHistory(name: string, tail: number): string[] {
  const buf = containerHistory.get(name);
  if (!buf) return [];
  return buf.slice(-tail);
}

export async function registerLogStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: { tail?: string } }>(
    '/api/containers/:name/logs/stream',
    async (req, reply: FastifyReply) => {
      const name = req.params.name;
      if (!/^[a-z0-9][-_a-z0-9]*$/i.test(name)) {
        reply.code(400);
        return { error: 'invalid container name' };
      }
      const tail = Math.max(1, Math.min(5000, Number.parseInt(req.query.tail ?? '200', 10) || 200));

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      // Backfill from the in-memory history first so the client doesn't
      // see a blank pane while the broker primes its follow-stream.
      const history = getHistory(name, tail);
      for (const line of history) reply.raw.write(`data: ${line}\n\n`);

      // The broker keeps a single follow-stream against the runtime
      // daemon regardless of how many SSE clients connect. Lifting this
      // pattern from signalk-container — it survived auto-recreate,
      // crashloops, and daemon glitches there, and the engine container
      // has the same failure modes.
      const broker = getOrCreateBroker(name, history.length === 0 ? tail : 0);

      let alive = true;

      const unsubscribe = broker.subscribe({
        onLine: (line) => {
          pushHistory(name, line);
          if (!alive) return;
          reply.raw.write(`data: ${line}\n\n`);
        },
        onClose: (reason) => {
          if (!alive) return;
          reply.raw.write(`event: end\ndata: ${reason}\n\n`);
          reply.raw.end();
        },
      });

      const heartbeat = setInterval(() => {
        if (alive) reply.raw.write(`: heartbeat\n\n`);
      }, HEARTBEAT_MS);

      req.raw.on('close', () => {
        alive = false;
        clearInterval(heartbeat);
        unsubscribe();
      });

      return reply;
    },
  );

  // Convenience one-shot endpoint that returns whatever's currently in
  // the broker history. Used by the Logs Refresh button for any
  // container. signalk-server has its own logs endpoint (built into the
  // server) that we keep for backwards compat, but going through the
  // broker history is faster (no daemon roundtrip) and works for all
  // three containers uniformly.
  app.get<{ Params: { name: string }; Querystring: { tail?: string } }>(
    '/api/containers/:name/logs',
    async (req, reply) => {
      const name = req.params.name;
      if (!/^[a-z0-9][-_a-z0-9]*$/i.test(name)) {
        reply.code(400);
        return { error: 'invalid container name' };
      }
      const tail = Math.max(1, Math.min(5000, Number.parseInt(req.query.tail ?? '200', 10) || 200));
      // Touch the broker to ensure history is being collected even
      // before the first SSE client connects.
      getOrCreateBroker(name, tail);
      reply.type('text/plain; charset=utf-8').send(getHistory(name, tail).join('\n'));
      return reply;
    },
  );
}
