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
/** GPS time that does not move within this long is not live, so not used. */
export const LIVE_WAIT_MS = 2500;
const POLL_MS = 250;
/** Longest window in which a new GPS time may have reached signalk-server
 *  for the probe to time it: the offset is off by at most half of it. */
export const MAX_SPAN_MS = 1000;
/** Wall and monotonic time disagreeing by more than this over one span means
 *  the host clock was stepped, by signalk-timesync for example. */
const CLOCK_STEP_MS = 250;
const HOP_TIMEOUT_MS = 3000;
const DATETIME_PATH = '/signalk/v1/api/vessels/self/navigation/datetime';

export type GpsTime =
  /** `observedAt` is the host time at which `value` was current. */
  | { ok: true; value: string; observedAt: number }
  | {
      ok: false;
      reason: 'no-token' | 'no-data' | 'stale' | 'slow' | 'unreachable';
      detail: string;
    };

export type HostTimeState =
  | { ok: true; timerLoaded: boolean; timerActive: boolean; ntpSynchronized: boolean }
  | { ok: false; detail: string };

export interface ClockGpsSources {
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

interface Answer {
  res: Response;
  body: unknown;
}

/** One request whose timeout also covers reading the JSON body, which
 *  arrives after `hop` has resolved with the headers. */
async function hopJson(
  url: string,
  headers: Record<string, string>,
  tlsRelaxed: boolean,
  deadline: ProbeDeadline,
): Promise<Answer> {
  const ms = deadline.hop(HOP_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await hop(
      url,
      { manualRedirect: !tlsRelaxed, tlsRelaxed, headers, signal: controller.signal },
      ms,
    );
    if (!res.ok) {
      await res.body?.cancel();
      return { res, body: undefined };
    }
    try {
      return { res, body: await res.json() };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`${url} did not send its whole answer within ${ms} ms`, { cause: err });
      }
      throw new Error(`${url} answered with invalid JSON`, { cause: err });
    }
  } finally {
    clearTimeout(timer);
  }
}

/** GET a signalk-server path (relative to the server root) with the admin
 *  token: over HTTP, following the redirect signalk-server answers with when
 *  SSL is enabled, or straight over HTTPS when HTTP cannot be reached.
 *  Resolves with the JSON body, null for a 404, or throws an operator-readable
 *  error. */
async function getSignalk(path: string, token: string, deadline: ProbeDeadline): Promise<unknown> {
  const root = (u: string): string => u.replace(/\/signalk\/?$/, '');
  const headers = { authorization: `Bearer ${token}` };
  const httpUrl = root(signalkHttpUrl()) + path;
  const https = signalkHttpsUrl();
  const httpsUrl = https ? root(https) + path : null;
  let answer: Answer;
  try {
    answer = await hopJson(httpUrl, headers, false, deadline);
  } catch (err) {
    if (!httpsUrl || !deadline.allows(MIN_HOP_MS)) throw err;
    answer = await hopJson(httpsUrl, headers, true, deadline);
  }
  if (isRedirect(answer.res)) {
    if (!httpsUrl) throw new Error(`${httpUrl} redirects to HTTPS but no SIGNALK_HTTPS_URL is set`);
    if (!deadline.allows(MIN_HOP_MS)) throw new Error('no probe budget left for the HTTPS hop');
    answer = await hopJson(httpsUrl, headers, true, deadline);
  }
  const { res, body } = answer;
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return body;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

interface Reading {
  value: string;
  /** Host time when the request was sent and when the answer was read, and
   *  `performance.now()` at both. */
  sentAt: number;
  readAt: number;
  sentPerf: number;
  readPerf: number;
}

async function readDatetime(token: string, deadline: ProbeDeadline): Promise<Reading | null> {
  const sentAt = Date.now();
  const sentPerf = performance.now();
  const body = await getSignalk(DATETIME_PATH, token, deadline);
  const readPerf = performance.now();
  const readAt = Date.now();
  const value = isRecord(body) ? body.value : undefined;
  return typeof value === 'string' ? { value, sentAt, readAt, sentPerf, readPerf } : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reads navigation.datetime until it changes. Its `timestamp` cannot tell
 *  how old the value is: for RMC it is the GPS time itself, for NMEA 2000 the
 *  host's receive time. A value that changed between two reads reached
 *  signalk-server after the earlier request was sent and before the later
 *  answer was read; when that span is short the middle of it is when the
 *  value was current. The delay from the GPS receiver to signalk-server is
 *  not measurable here and is left out. */
export async function readGpsTime(token: string | null, deadline: ProbeDeadline): Promise<GpsTime> {
  if (!token) {
    return { ok: false, reason: 'no-token', detail: `no Signal K token at ${tokenPath()}` };
  }
  const noData: GpsTime = {
    ok: false,
    reason: 'no-data',
    detail: 'Signal K has no navigation.datetime',
  };
  try {
    const first = await readDatetime(token, deadline);
    if (!first) return noData;
    let prev = first;
    let changed = false;
    const started = performance.now();
    while (performance.now() - started < LIVE_WAIT_MS && deadline.allows(POLL_MS + MIN_HOP_MS)) {
      await sleep(POLL_MS);
      const next = await readDatetime(token, deadline);
      if (!next) return noData;
      if (next.value !== prev.value) {
        changed = true;
        const span = next.readPerf - prev.sentPerf;
        const stepped = Math.abs(next.readAt - prev.sentAt - span) > CLOCK_STEP_MS;
        if (span <= MAX_SPAN_MS && !stepped) {
          return { ok: true, value: next.value, observedAt: prev.sentAt + span / 2 };
        }
      }
      prev = next;
    }
    if (changed) {
      return {
        ok: false,
        reason: 'slow',
        detail: `Signal K answered too slowly to time GPS within ${MAX_SPAN_MS / 1000} s`,
      };
    }
    return {
      ok: false,
      reason: 'stale',
      detail: `navigation.datetime stayed at ${first.value}, so no GPS time is arriving`,
    };
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
    const body = await getSignalk(`/plugins/${PLUGIN_ID}/config`, token, deadline);
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
  if (load === undefined || active === undefined || (ntp !== 'yes' && ntp !== 'no')) {
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
      'ntp=$(timedatectl show -p NTPSynchronized --value) && echo "NTPSynchronized=$ntp"',
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
  return { gps, pluginEnabled, host, wsl };
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
  if (Number.isNaN(gpsMs)) {
    return done(warnings.length > 0 ? 'warn' : 'unknown', [
      ...warnings,
      `unreadable GPS time ${JSON.stringify(src.gps.value)}`,
    ]);
  }

  const offsetS = (gpsMs - src.gps.observedAt) / 1000;
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
