// Per-probe time budget, shared by the runner that enforces it and by the
// probes that have to live inside it.
//
// The runner races every probe against a ceiling and, when the ceiling wins,
// DISCARDS whatever the probe was about to say (see runner.ts). So a probe
// whose own timeouts can sum past that ceiling trades an actionable verdict —
// `cannot reach http://host.containers.internal:3003/api/health` — for a
// content-free `probe did not finish within 8000ms`, which is the opposite of
// this engine's job: it reads as "the doctor is broken" when the doctor in
// fact knows exactly what is wrong. Multi-hop probes therefore size their
// hops against the SAME budget the runner is holding them to, so they always
// get to speak for themselves.

/** Upper bound on how long any single probe may run before the runner gives
 *  up on it and marks it `unknown`. Without this, one wedged probe hangs the
 *  whole `/api/probes` response: the heaviest probe is `podman` (a dockerode
 *  call over the rootless socket), which on a contended/half-up cold boot can
 *  block long past the plugin proxy's 15s header watchdog — turning a slow
 *  probe into the alarming "Failed to run probes: HTTP 502". 8s is comfortably
 *  above the observed healthy worst case (podman ~2.7s, check-update ~10.5s
 *  pre-Happy-Eyeballs but now bounded by the 5s autoSelectFamily attempt) yet
 *  well under the proxy's 15s ceiling, so a single stuck probe degrades to
 *  `unknown` while the other twelve still report. Env-overridable so tests can
 *  shrink it without sleeping the runner; floored at 250ms. */
export function probeTimeoutMs(): number {
  const raw = Number(process.env.PROBE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.max(250, raw) : 8000;
}

/** Headroom held back from the ceiling so a probe that spends its entire
 *  budget still resolves BEFORE the runner's timer fires. Without it the two
 *  race at the same instant and the runner tends to win, throwing away the
 *  verdict the probe just spent the whole budget earning. Scaled down for
 *  very small ceilings so an env-shrunk budget stays inside the ceiling. */
const MARGIN_MS = 500;

/** Smallest hop worth starting. Below this a fetch is likelier to abort on
 *  the clock than to learn anything, and a self-inflicted timeout reads
 *  exactly like a genuinely unreachable endpoint — so a probe with less than
 *  this left should report the error it already has (saying the remaining hop
 *  was skipped) rather than manufacture a misleading one. */
export const MIN_HOP_MS = 1000;

export interface ProbeDeadline {
  /** Milliseconds left in the runner's budget. Never negative. */
  remaining(): number;
  /** Timeout to use for one hop: `want`, clamped to what is left. */
  hop(want: number): number;
  /** Whether `need` milliseconds are still available. */
  allows(need: number): boolean;
}

/** Open a budget for the probe now running. The ceiling is resolved at call
 *  time (not module load) so `PROBE_TIMEOUT_MS` stays overridable per test. */
export function startProbeDeadline(): ProbeDeadline {
  const ceiling = probeTimeoutMs();
  const endsAt = Date.now() + Math.max(1, ceiling - Math.min(MARGIN_MS, Math.ceil(ceiling / 10)));
  const remaining = (): number => Math.max(0, endsAt - Date.now());
  return {
    remaining,
    hop: (want: number): number => Math.min(want, remaining()),
    allows: (need: number): boolean => remaining() >= need,
  };
}
