import { readFile } from 'node:fs/promises';
import type { ProbeResult } from './types.js';
import { signalkHttpUrl, signalkHttpsUrl } from './signalk-url.js';
import { hop, isRedirect } from './signalk-health.js';
import { MIN_HOP_MS, startProbeDeadline, type ProbeDeadline } from './budget.js';
import { describeFetchError } from './fetch-error.js';
import { runHostShell } from '../host-timezone.js';
import { isWsl } from '../host-boots.js';

// Checks that the host clock follows the boat's GPS. On an installer box the
// clock is set by signalk-timesync, a root systemd timer on the host: it reads
// navigation.datetime from signalk-server and steps the clock when the host
// has no NTP sync. Nothing inside a rootless container can set the clock
// (CLOCK_REALTIME needs CAP_SYS_TIME in the initial user namespace), so the
// set-system-time plugin only ever reports a sudo or permission error here.
//
// The doctor's clock is the host's: CLOCK_REALTIME is not namespaced.

const ID = 'clock-gps';
const LABEL = 'System clock vs GPS';
const PLUGIN_ID = 'set-system-time';
const TIMER = 'signalk-timesync.timer';
/** The agent steps the clock once it is 10 s off and runs every 5 min. */
export const MAX_OFFSET_S = 30;
/** GPS data older than this, by signalk-server's own timestamp, is not used. */
export const MAX_AGE_S = 60;
const HOP_TIMEOUT_MS = 3000;

export type GpsTime =
  | { ok: true; value: string; timestamp: string }
  | { ok: false; reason: 'no-token' | 'no-data' | 'unreachable'; detail: string };

export type HostTimeState =
  | { ok: true; timerLoaded: boolean; timerActive: boolean; ntpSynchronized: boolean }
  | { ok: false; detail: string };

export interface ClockGpsSources {
  now: number;
  gps: GpsTime;
  /** Whether set-system-time is enabled; null when it could not be read. */
  pluginEnabled: boolean | null;
  host: HostTimeState;
  /** Under WSL the clock is Windows' and signalk-timesync is not used. */
  wsl: boolean;
}

export interface ClockGpsDeps {
  gatherSources?: () => Promise<ClockGpsSources>;
}

function tokenPath(): string {
  return process.env.SIGNALK_TOKEN_PATH ?? '/data/signalk-token';
}

async function readToken(): Promise<string | null> {
  try {
    const t = (await readFile(tokenPath(), 'utf8')).trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** GET a signalk-server path (relative to the server root) with the admin
 *  token, following the HTTP→HTTPS redirect signalk-server answers with when
 *  SSL is enabled. Resolves with the response, null for a 404, or throws an
 *  operator-readable error. */
async function getSignalk(
  path: string,
  token: string,
  deadline: ProbeDeadline,
): Promise<Response | null> {
  const root = (u: string): string => u.replace(/\/signalk\/?$/, '');
  const headers = { authorization: `Bearer ${token}` };
  const httpUrl = root(signalkHttpUrl()) + path;
  let res = await hopWithHeaders(httpUrl, headers, false, deadline);
  if (isRedirect(res)) {
    const https = signalkHttpsUrl();
    if (!https) throw new Error(`${httpUrl} redirects to HTTPS but no SIGNALK_HTTPS_URL is set`);
    if (!deadline.allows(MIN_HOP_MS)) throw new Error('no probe budget left for the HTTPS hop');
    res = await hopWithHeaders(root(https) + path, headers, true, deadline);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res;
}

function hopWithHeaders(
  url: string,
  headers: Record<string, string>,
  tlsRelaxed: boolean,
  deadline: ProbeDeadline,
): Promise<Response> {
  return hop(
    url,
    { manualRedirect: !tlsRelaxed, tlsRelaxed, headers },
    deadline.hop(HOP_TIMEOUT_MS),
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function readGpsTime(token: string | null, deadline: ProbeDeadline): Promise<GpsTime> {
  if (!token) {
    return { ok: false, reason: 'no-token', detail: `no Signal K token at ${tokenPath()}` };
  }
  try {
    const res = await getSignalk(
      '/signalk/v1/api/vessels/self/navigation/datetime',
      token,
      deadline,
    );
    if (!res)
      return { ok: false, reason: 'no-data', detail: 'Signal K has no navigation.datetime' };
    const body: unknown = await res.json();
    const value = isRecord(body) ? body.value : undefined;
    const timestamp = isRecord(body) ? body.timestamp : undefined;
    if (typeof value !== 'string' || typeof timestamp !== 'string') {
      return { ok: false, reason: 'no-data', detail: 'navigation.datetime has no value' };
    }
    return { ok: true, value, timestamp };
  } catch (err) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: err instanceof Error ? err.message : describeFetchError(err, 0),
    };
  }
}

export async function readPluginEnabled(
  token: string | null,
  deadline: ProbeDeadline,
): Promise<boolean | null> {
  if (!token) return null;
  try {
    const res = await getSignalk(`/plugins/${PLUGIN_ID}/config`, token, deadline);
    if (!res) return false;
    const body: unknown = await res.json();
    return isRecord(body) && body.enabled === true;
  } catch {
    return null;
  }
}

/** Parse the host script's `key=value` lines. */
export function parseHostState(stdout: string): HostTimeState {
  const kv = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const load = kv.get('LoadState');
  const active = kv.get('ActiveState');
  const ntp = kv.get('NTPSynchronized');
  if (load === undefined || active === undefined || ntp === undefined) {
    return { ok: false, detail: `unexpected host output (${JSON.stringify(stdout.trim())})` };
  }
  return {
    ok: true,
    timerLoaded: load === 'loaded',
    timerActive: active === 'active',
    ntpSynchronized: ntp === 'yes',
  };
}

async function readHostState(): Promise<HostTimeState> {
  const r = await runHostShell(
    `systemctl show -p LoadState -p ActiveState ${TIMER}; ` +
      'echo "NTPSynchronized=$(timedatectl show -p NTPSynchronized --value)"',
  );
  return r.ok ? parseHostState(r.stdout) : { ok: false, detail: `${r.reason}: ${r.detail}` };
}

async function gatherSourcesReal(): Promise<ClockGpsSources> {
  const deadline = startProbeDeadline();
  const token = await readToken();
  const [gps, pluginEnabled, host, wsl] = await Promise.all([
    readGpsTime(token, deadline),
    readPluginEnabled(token, deadline),
    readHostState(),
    isWsl(),
  ]);
  return { now: Date.now(), gps, pluginEnabled, host, wsl };
}

function seconds(s: number): string {
  const a = Math.abs(s);
  if (a < 120) return `${Math.round(a)} s`;
  if (a < 7200) return `${Math.round(a / 60)} min`;
  return `${Math.round(a / 3600)} h`;
}

export async function probeClockGps(deps: ClockGpsDeps = {}): Promise<ProbeResult> {
  const t0 = Date.now();
  const src = await (deps.gatherSources ?? gatherSourcesReal)();
  const details: Record<string, unknown> = {
    gps: src.gps.ok ? src.gps.value : null,
    pluginEnabled: src.pluginEnabled,
    timerLoaded: src.host.ok ? src.host.timerLoaded : null,
    timerActive: src.host.ok ? src.host.timerActive : null,
    ntpSynchronized: src.host.ok ? src.host.ntpSynchronized : null,
  };
  const done = (status: ProbeResult['status'], parts: string[]): ProbeResult => ({
    id: ID,
    label: LABEL,
    status,
    message: parts.join('; '),
    details,
    durationMs: Date.now() - t0,
  });

  const warnings: string[] = [];
  if (src.pluginEnabled === true) {
    warnings.push(
      `the ${PLUGIN_ID} plugin is enabled but cannot set the clock in this setup; ` +
        'signalk-timesync sets it from GPS, so disable the plugin',
    );
  }
  const timesync = src.host.ok && !src.wsl ? src.host : null;
  if (timesync && !timesync.timerLoaded) {
    warnings.push(
      'signalk-timesync is not installed, so the clock does not follow GPS; re-run the installer',
    );
  } else if (timesync && !timesync.timerActive) {
    warnings.push(
      'the signalk-timesync timer is off, so the clock does not follow GPS without NTP; re-run the installer to switch it on',
    );
  }

  if (!src.gps.ok) {
    if (src.gps.reason === 'no-token' && !src.wsl) {
      warnings.push(
        `${src.gps.detail}: signalk-timesync cannot read GPS time either; re-run the installer`,
      );
      return done('warn', warnings);
    }
    if (warnings.length > 0) return done('warn', [...warnings, src.gps.detail]);
    return done('unknown', [`cannot compare with GPS: ${src.gps.detail}`]);
  }

  const gpsMs = Date.parse(src.gps.value);
  const stampMs = Date.parse(src.gps.timestamp);
  if (Number.isNaN(gpsMs) || Number.isNaN(stampMs)) {
    return done(warnings.length > 0 ? 'warn' : 'unknown', [
      ...warnings,
      `unreadable GPS time ${JSON.stringify(src.gps.value)}`,
    ]);
  }
  const ageS = (src.now - stampMs) / 1000;
  if (ageS < 0 || ageS > MAX_AGE_S) {
    return done(warnings.length > 0 ? 'warn' : 'unknown', [
      ...warnings,
      `GPS time is ${seconds(ageS)} old, not compared`,
    ]);
  }

  const offsetS = (gpsMs - src.now) / 1000;
  details.offsetSec = Math.round(offsetS);
  if (Math.abs(offsetS) <= MAX_OFFSET_S) {
    const inSync = `clock within ${seconds(offsetS)} of GPS`;
    return warnings.length > 0 ? done('warn', [...warnings, inSync]) : done('ok', [inSync]);
  }

  const off = `clock is ${seconds(offsetS)} ${offsetS > 0 ? 'behind' : 'ahead of'} GPS`;
  if (src.wsl) {
    return done('warn', [
      ...warnings,
      `${off}; under Windows the clock is the Windows clock, so set it there or let Windows sync it`,
    ]);
  }
  if (!src.host.ok) {
    return done('warn', [
      ...warnings,
      `${off} (cannot read the time sync state: ${src.host.detail})`,
    ]);
  }
  if (src.host.ntpSynchronized) {
    return done('warn', [
      ...warnings,
      `${off} while NTP is synchronised; signalk-timesync leaves an NTP clock alone, so check the GPS source`,
    ]);
  }
  if (src.host.timerActive) {
    return done('warn', [
      ...warnings,
      `${off} although signalk-timesync is on and there is no NTP; its log is in the bug report`,
    ]);
  }
  return done('warn', [off, ...warnings]);
}
