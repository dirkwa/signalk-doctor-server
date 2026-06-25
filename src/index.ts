import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { createServer } from './server.js';
import { pruneOldImagesFor } from './image-retention.js';
import { withMutex } from './mutex.js';
import { SELF_IMAGE } from './routes/self.js';

// Happy-Eyeballs (RFC 8305) attempt timeout for ALL outbound connections,
// including global fetch() — which is how the version-drift / updater-health /
// signalk-health / time-drift probes and src/ghcr.ts reach their endpoints.
// Node 20+ enables autoSelectFamily by default with a per-address connect
// cap that is far too short for a slow boat link (250ms on Node 20, 500ms
// on Node 24). On a dual-stack host (ghcr.io and the npm registry are
// Cloudflare-fronted and resolve A+AAAA) reached over a slow link (boat
// LTE/satellite), the first address family's connect can't complete in
// that window, so the whole
// request fails fast with an ETIMEDOUT/"fetch failed" that the app can't
// extend with its own timeout — surfacing as the alarming "Failed to run
// probes: HTTP 502" the doctor reports. Widen the cap to 5s (matching the
// signalk-updater-server fix and noforeignland/nfl-signalk#47 for the same
// Node bug on boat links). Built into node:net — no undici/agent dependency,
// so it works in the production --omit=dev image.
// Guard the env override: a non-numeric or absent value falls back to 5000
// (|| handles NaN), and the floor of 250 (Node 20's original default) keeps
// a misconfigured "0"/"50" from re-introducing the very instant-fail this
// widens past. A NaN must never reach the setter.
const AUTOSELECT_FAMILY_ATTEMPT_TIMEOUT_MS = Math.max(
  250,
  Number(process.env.AUTOSELECT_FAMILY_ATTEMPT_TIMEOUT_MS) || 5000,
);
setDefaultAutoSelectFamilyAttemptTimeout(AUTOSELECT_FAMILY_ATTEMPT_TIMEOUT_MS);

const PORT = Number(process.env.PORT ?? 3004);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const { app, driftScheduler } = await createServer();
  try {
    await app.listen({ port: PORT, host: HOST });
    driftScheduler.start();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Reap old doctor images on boot. The updater only prunes the doctor's images
  // when IT drives the doctor-update; a manual / installer-driven doctor change
  // leaves the prior version on disk. Pruning here on boot — after the new image
  // is confirmed running — gives the doctor the same self-healing the updater
  // has for its own image, regardless of how the new image arrived.
  //
  // Image removal is a mutating op, so it goes through the single-writer mutex
  // (CC-5, shared with the updater) under 'self-update'. If the updater holds the
  // lock at boot, withMutex throws MutexBusyError; swallow it and let the next
  // boot try. Fire-and-forget — never block startup on GC.
  void withMutex('self-update', () =>
    pruneOldImagesFor(SELF_IMAGE, 'signalk-doctor-server', { protectTags: ['beta'] }, app.log),
  ).catch((err: unknown) => {
    app.log.debug({ err }, 'boot image-retention skipped (lock busy or unavailable)');
  });
}

void main();
