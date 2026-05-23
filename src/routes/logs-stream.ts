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

// Brokers don't spawn their dockerode follow-stream until at least one
// subscriber attaches. To make the one-shot /logs endpoint usable
// before any SSE client connects, we keep a permanent internal
// subscriber per container that captures every line into the history
// ring buffer. The subscriber is created lazily by warmBroker(); once
// created it stays for the lifetime of the engine.
const warmedContainers = new Set<string>();

function warmBroker(name: string): void {
  if (warmedContainers.has(name)) return;
  // Subscribe before marking warm: if getOrCreateBroker or subscribe
  // throws (e.g. runtime not reachable), we want the next call to
  // retry rather than silently leaving the container forever cold.
  //
  // The permanent subscriber always asks dockerode for the full
  // ring-buffer worth of backfill. Otherwise a tail=10 first request
  // would lock the buffer to 10 lines forever; subsequent SSE clients
  // asking for tail=500 would still only see 10.
  const broker = getOrCreateBroker(name, BACKFILL_LIMIT);
  broker.subscribe({
    onLine: (line) => pushHistory(name, line),
    // When the broker closes (container removed, engine shutting
    // down), drop our warm flag and history so the next request for
    // this container name starts clean. Without this, a removed
    // container's name stays in `warmedContainers` forever — even
    // if a fresh container with the same name comes up later, the
    // early-return at the top of warmBroker prevents us from
    // attaching a new subscriber to the new broker, and history
    // capture silently stops.
    onClose: () => {
      warmedContainers.delete(name);
      containerHistory.delete(name);
    },
  });
  warmedContainers.add(name);
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

      // Make sure the permanent history-capture subscriber is in place
      // before backfilling; otherwise a brand-new container would get
      // an empty backfill on first connect.
      warmBroker(name);

      // Atomic backfill → live handoff. Naive ordering (snapshot
      // history → write → subscribe) drops every line emitted
      // between the snapshot and the subscribe call. To close the
      // race:
      //   1. Subscribe FIRST with a buffering handler (no socket
      //      writes yet) so we don't miss any live lines.
      //   2. Snapshot history.
      //   3. Write history to the socket.
      //   4. Flush any lines the buffer captured during steps 2-3,
      //      dropping ones already in the history snapshot to avoid
      //      visible duplicates.
      //   5. Flip the handler over to direct socket writes.
      let alive = true;
      let liveMode = false;
      const buffered: string[] = [];

      const broker = getOrCreateBroker(name, 0);
      const unsubscribe = broker.subscribe({
        onLine: (line) => {
          if (!alive) return;
          if (liveMode) {
            reply.raw.write(`data: ${line}\n\n`);
          } else {
            buffered.push(line);
          }
        },
        onClose: (reason) => {
          if (!alive) return;
          reply.raw.write(`event: end\ndata: ${reason}\n\n`);
          reply.raw.end();
        },
      });

      const history = getHistory(name, tail);
      for (const line of history) reply.raw.write(`data: ${line}\n\n`);

      // Drain whatever leaked into the buffer while we were writing
      // history. Skip any prefix already covered by the history
      // snapshot — easy because history is the chronologically older
      // window, so any buffered line that's a string-equal duplicate
      // of the last few history entries is the same one.
      //
      // Trade-off: string-equality dedup can over-skip when a
      // container legitimately emits the same line twice in rapid
      // succession (e.g. repeated "Error connecting to …" lines that
      // straddle the handoff). In that case the second occurrence is
      // dropped from the client view; the broker's ring buffer still
      // has both. Bullet-proof fix would need sequence IDs or
      // timestamps from the broker — not worth the complexity given
      // the handoff window is sub-millisecond in practice and the
      // dropped line is by definition identical to one already shown.
      const lastHistory = history.length > 0 ? history[history.length - 1] : null;
      let drainStart = 0;
      if (lastHistory !== null) {
        const idx = buffered.lastIndexOf(lastHistory);
        if (idx !== -1) drainStart = idx + 1;
      }
      for (let i = drainStart; i < buffered.length; i++) {
        reply.raw.write(`data: ${buffered[i]}\n\n`);
      }
      buffered.length = 0;
      liveMode = true;

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
      // Cold-start UX: warmBroker() attaches a permanent subscriber on
      // first call, but the broker's underlying dockerode follow-stream
      // resolves asynchronously. A Refresh issued in the same tick
      // that first warms the broker returns whatever history is
      // already buffered — typically empty for a brand-new container.
      // The webapp renders an explicit "no log output yet — click
      // Stream to subscribe" hint in that case, so subsequent clicks
      // just work.
      warmBroker(name);
      reply.type('text/plain; charset=utf-8').send(getHistory(name, tail).join('\n'));
      return reply;
    },
  );
}
