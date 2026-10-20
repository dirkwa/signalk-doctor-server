import { hostBootsPath, isWsl, loadHostBoots } from '../host-boots.js';
import type { ProbeResult } from './types.js';

// Surfaces the restarts src/host-boots.ts recorded: boots that ended without
// systemd stopping the doctor first. A hardware watchdog brings a hung host
// back without a trace in the UI, so this is where such a recovery shows up.

const ID = 'host-restarts';
const LABEL = 'Unclean host restarts';
const WINDOW_DAYS = 7;

export async function probeHostRestarts(now = new Date()): Promise<ProbeResult> {
  const t0 = Date.now();
  const result = (
    status: ProbeResult['status'],
    message: string,
    details?: Record<string, unknown>,
  ): ProbeResult => ({
    id: ID,
    label: LABEL,
    status,
    message,
    ...(details ? { details } : {}),
    durationMs: Date.now() - t0,
  });

  if (await isWsl()) {
    return result(
      'ok',
      'Not tracked under WSL: Windows stops the Podman machine without shutting it down, so every Windows restart would count',
    );
  }

  const state = await loadHostBoots();
  if (!state) {
    return result(
      'unknown',
      `No boot record in ${hostBootsPath()}; the doctor writes it at startup`,
    );
  }

  const cutoff = now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = state.unclean.filter((e) => Date.parse(e.detectedAt) >= cutoff);
  const earlier = state.unclean.length - recent.length;
  const details = { trackingSince: state.trackingSince, recent, earlier };

  const last = recent.at(-1);
  if (last) {
    const times = recent.length === 1 ? 'once' : `${recent.length} times`;
    return result(
      'warn',
      `The host restarted without a clean shutdown ${times} in the last ${WINDOW_DAYS} days, ` +
        `most recently back up at ${last.hostBootedAt ?? last.detectedAt}. ` +
        'A hardware-watchdog reset, a power cut or a kernel panic ends a boot this way; ' +
        "'signalk bug-report' collects the power-supply state and the end of the previous boot's journal",
      details,
    );
  }
  return result(
    'ok',
    `No restart without a clean shutdown in the last ${WINDOW_DAYS} days` +
      (earlier > 0 ? ` (${earlier} earlier)` : '') +
      `; tracking since ${state.trackingSince}`,
    details,
  );
}
