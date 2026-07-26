import type { ProbeResult } from './types.js';
import { resolveRuntime, safe } from '../podman/client.js';
import { execInContainer } from '../podman/exec.js';
import { readHostTimezone, type HostTimezoneResult } from '../host-timezone.js';

// Detect timezone drift across the three layers that can diverge on a boat
// that changes zone mid-passage:
//
//   1. HOST zone — set from GPS by the signalk-timesync agent (authoritative).
//   2. signalk-server zone — frozen at container-create by `Timezone=local`
//      (podman --tz=local writes /etc/localtime once; a running container
//      never re-reads it). This is the layer that LAGS after a host change.
//   3. PEER container zones — the TZ env signalk-container injects into
//      questdb/grafana/Node-RED at ensureRunning; re-applied only on recreate.
//
// signalk-container publishes no queryable "active zone", so the doctor
// assembles the comparison itself. The fix for any drift is the same:
// recreate signalk-server (re-runs Timezone=local + re-triggers TZ
// propagation), offered as a one-click restart on the Recovery tab.

// UTC-equivalent zones: if the host is on one of these there is nothing to
// propagate (signalk-container itself treats these as "inject nothing"), so
// a container still on UTC is not drift. Mirrors signalk-container's
// UTC_ZONE_NAMES set.
const UTC_ZONES = new Set([
  'UTC',
  'Etc/UTC',
  'GMT',
  'Etc/GMT',
  'Zulu',
  'Universal',
  'Etc/Universal',
]);

// Peer containers whose zone signalk-container manages. Enumerated from the
// runtime (only those actually present are checked) — this is the label set
// we recognize, not a hard requirement that they exist.
const KNOWN_PEERS = ['questdb', 'grafana', 'node-red', 'wyoming-satellite'];

export interface TimezoneSources {
  host: HostTimezoneResult;
  /** IANA zone signalk-server's container actually resolves (via Intl), or
   *  null when it can't be read (container down / exec failed). */
  server: string | null;
  serverError: string | null;
  /** TZ env of each PRESENT managed peer. The value is null when the peer is
   *  running but has no TZ set — a propagation failure we must surface, not
   *  hide. Absent (not-installed) peers are simply not keys here. */
  peers: Record<string, string | null>;
  peerError: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Two zones are equivalent when they're the same IANA name, both UTC
// aliases, or resolve to the same canonical zone (e.g. US/Eastern ==
// America/New_York). Intl's resolvedOptions().timeZone canonicalizes a valid
// alias; an invalid string throws, so we fall back to raw string compare.
function canonical(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return zone;
  }
}
function zonesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (UTC_ZONES.has(a) && UTC_ZONES.has(b)) return true;
  return canonical(a) === canonical(b);
}

// ── Real readers (overridable in tests via the `deps` param) ───────────────

/** Read signalk-server's effective IANA zone the same way signalk-container
 *  does — Intl inside the container, which honors /etc/localtime (set by
 *  Timezone=local at create). Authoritative and needs no host time files. */
export async function readServerZone(): Promise<{ zone: string | null; error: string | null }> {
  const r = await execInContainer(
    'signalk-server',
    ['node', '-e', 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)'],
    '/',
    5000,
  );
  if (!r.ok) {
    // Container down / unreachable is benign "can't tell", not a hard fail.
    return { zone: null, error: `${r.reason}: ${r.detail}` };
  }
  const zone = r.output.trim();
  return {
    zone: zone.length > 0 ? zone : null,
    error: zone.length > 0 ? null : 'empty zone from Intl',
  };
}

/** Read the TZ env of each present managed peer container via inspect. A
 *  present peer with no TZ maps to null (surfaced as a propagation failure);
 *  a not-installed peer is omitted. */
export async function readPeerZones(): Promise<{
  peers: Record<string, string | null>;
  error: string | null;
}> {
  const rt = await resolveRuntime();
  if (!rt) return { peers: {}, error: null };
  const peers: Record<string, string | null> = {};
  // Accumulate errors across peers instead of bailing on the first one: a
  // single unreachable/malformed peer must not hide a later peer's real drift.
  const errors: string[] = [];
  for (const name of KNOWN_PEERS) {
    const res = await safe(() => rt.client.getContainer(name).inspect());
    if (!res.ok) {
      if (res.error.kind === 'not-found') continue; // peer not installed — benign
      errors.push(`${name}: ${res.error.kind}: ${res.error.userMessage}`);
      continue;
    }
    // Narrow the dockerode payload rather than assert its shape (CC-6 posture).
    const config = isRecord(res.value) && isRecord(res.value.Config) ? res.value.Config : null;
    const rawEnv = config?.Env;
    if (!Array.isArray(rawEnv) || !rawEnv.every((e) => typeof e === 'string')) {
      errors.push(`${name}: malformed inspect response (no Config.Env array)`);
      continue;
    }
    const tzEntry = rawEnv.find((e) => e.startsWith('TZ='));
    peers[name] = tzEntry === undefined ? null : tzEntry.slice('TZ='.length);
  }
  return { peers, error: errors.length > 0 ? errors.join('; ') : null };
}

export interface TimezoneDriftDeps {
  gatherSources?: () => Promise<TimezoneSources>;
}

async function gatherSourcesReal(): Promise<TimezoneSources> {
  const [host, server, peers] = await Promise.all([
    readHostTimezone(),
    readServerZone(),
    readPeerZones(),
  ]);
  return {
    host,
    server: server.zone,
    serverError: server.error,
    peers: peers.peers,
    peerError: peers.error,
  };
}

const ID = 'timezone-drift';
const LABEL = 'Timezone drift';

function result(
  status: ProbeResult['status'],
  message: string,
  details: Record<string, unknown>,
  t0: number,
): ProbeResult {
  return { id: ID, label: LABEL, status, message, details, durationMs: Date.now() - t0 };
}

export async function probeTimezoneDrift(deps: TimezoneDriftDeps = {}): Promise<ProbeResult> {
  const t0 = Date.now();
  const gather = deps.gatherSources ?? gatherSourcesReal;
  const src = await gather();

  const details: Record<string, unknown> = {
    hostZone: src.host.ok ? src.host.zone : null,
    serverZone: src.server,
    peers: src.peers,
  };

  // Can't read the host zone → we can't judge drift. Unknown, not fail:
  // this is a diagnostic, and a missing host reader (systemd-run/timedatectl
  // unavailable) shouldn't read as "everything is fine".
  if (!src.host.ok) {
    return result(
      'unknown',
      `cannot read host timezone (${src.host.reason}: ${src.host.detail})`,
      details,
      t0,
    );
  }
  const hostZone = src.host.zone;

  // Couldn't read signalk-server's zone (container down / exec failed) →
  // unknown, surface why. We do NOT short-circuit on a UTC host: a host that
  // just changed TO UTC can leave signalk-server or a peer stuck on the old
  // non-UTC zone, which is real drift — zonesMatch handles UTC equivalence
  // during the comparisons instead.
  if (src.server === null) {
    return result(
      'unknown',
      `host is ${hostZone} but signalk-server's zone is unreadable (${src.serverError ?? 'unknown'})`,
      details,
      t0,
    );
  }

  const warnings: string[] = [];

  // Root cause: signalk-server hasn't picked up the host's zone.
  if (!zonesMatch(src.server, hostZone)) {
    warnings.push(
      `signalk-server is on ${src.server} but the host is ${hostZone} — restart signalk-server to apply the new zone`,
    );
  }

  // Partial propagation: server agrees but a peer's injected TZ lags (e.g. a
  // peer wasn't reconciled after the last recreate), or a running peer has no
  // TZ at all (injection failure). Only meaningful when the server itself is
  // aligned; if the server drifts, the message above already tells the user
  // to restart, which fixes the peers too.
  if (zonesMatch(src.server, hostZone)) {
    for (const [name, tz] of Object.entries(src.peers)) {
      if (tz === null) {
        warnings.push(`peer ${name} has no TZ set while the host is ${hostZone}`);
      } else if (!zonesMatch(tz, hostZone)) {
        warnings.push(`peer ${name} is on ${tz} but the host is ${hostZone}`);
      }
    }
  }

  // A peer read error is worth surfacing but shouldn't mask a clean verdict.
  if (src.peerError) {
    warnings.push(`could not read every peer's zone (${src.peerError})`);
  }

  if (warnings.length > 0) {
    return result('warn', warnings.join('; '), details, t0);
  }

  const peerNote =
    Object.keys(src.peers).length > 0 ? ` (peers: ${Object.keys(src.peers).join(', ')})` : '';
  return result('ok', `host, signalk-server${peerNote} all on ${hostZone}`, details, t0);
}
