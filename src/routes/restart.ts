import type { FastifyInstance } from 'fastify';
import { restartUnit } from '../dbus/systemd-user.js';
import { requireToken } from '../auth.js';
import { withMutex, MutexBusyError } from '../mutex.js';

// Plain recreate of signalk-server — distinct from /api/recover, which
// restores a last-known-good Quadlet before restarting. Here we want the
// CURRENT Quadlet re-applied: a `podman run --replace` re-runs `Timezone=local`
// (fresh /etc/localtime from the host zone) and re-triggers signalk-container's
// TZ propagation into the peer containers. The primary consumer is the
// timezone-drift probe's "apply the new zone" action, but it's a general
// "bounce the data plane" button.
//
// The doctor uses its OWN busctl restart (systemd-user.restartUnit), not the
// updater's REST API. That is deliberate: the doctor is the independent
// recovery layer that must work when the updater is broken (AGENTS.md), so it
// never depends on the updater being reachable — unlike the host-side
// installer/agent, whose lifecycle ops route through the updater.
//
// No daemon-reload: this isn't a Quadlet change, so the generated unit is
// unchanged and a plain RestartUnit is enough (and cheaper than reload+restart).
const SIGNALK_SERVER_UNIT = 'signalk-server.service';

export async function registerRestartRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/restart/signalk-server', { preHandler: requireToken }, async (req, reply) => {
    try {
      return await withMutex('restart', async () => {
        await restartUnit(SIGNALK_SERVER_UNIT);
        return { ok: true, unit: SIGNALK_SERVER_UNIT };
      });
    } catch (err) {
      // CC-5: another operation holds the shared lock. Return the holder AND
      // an actionable instruction (wait, or force-clear the lock) rather than
      // just the raw "busy" message.
      if (err instanceof MutexBusyError) {
        reply.code(409);
        return {
          error: err.message,
          lock: err.lock,
          hint: `Another operation (${err.lock.owner}/${err.lock.operation}) holds the lock. Wait for it to finish, or force-clear the operation lock if it is stale, then retry.`,
        };
      }
      // Anything else is a busctl/systemd failure whose raw message can carry
      // host internals (unit paths, DBus addresses). Log the detail for the
      // operator's journal; return a generic message to the client.
      req.log.error({ err, unit: SIGNALK_SERVER_UNIT }, 'signalk-server restart failed');
      reply.code(500);
      return { error: `failed to restart ${SIGNALK_SERVER_UNIT}` };
    }
  });
}
