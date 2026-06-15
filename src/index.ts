import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { createServer } from './server.js';

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
}

void main();
