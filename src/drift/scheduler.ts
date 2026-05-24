import type { FastifyBaseLogger } from 'fastify';
import { runDriftScan } from './scanner.js';

const FIRST_SCAN_DELAY_MS = 60_000; // give signalk-server time to come up
const MIN_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const BACKOFF_INITIAL_MS = 15 * 60 * 1000; // 15min
const BACKOFF_MAX_MS = MAX_INTERVAL_MS;

function nextHealthyDelay(): number {
  const span = MAX_INTERVAL_MS - MIN_INTERVAL_MS;
  return MIN_INTERVAL_MS + Math.floor(Math.random() * span);
}

interface InflightHandle {
  promise: Promise<void>;
}

export class DriftScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private currentBackoffMs = BACKOFF_INITIAL_MS;
  private inflight: InflightHandle | null = null;

  constructor(private readonly log: FastifyBaseLogger) {}

  start(): void {
    if (this.stopped) return;
    this.scheduleNext(FIRST_SCAN_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Trigger an immediate scan, coalescing concurrent callers onto a single run. */
  async refreshNow(): Promise<void> {
    if (this.inflight) {
      return this.inflight.promise;
    }
    const promise = this.runOnce();
    this.inflight = { promise };
    try {
      await promise;
    } finally {
      this.inflight = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.refreshNow().then(() => {
        // refreshNow updates currentBackoffMs based on outcome; pick the
        // delay accordingly.
        const next =
          this.currentBackoffMs === BACKOFF_INITIAL_MS ? nextHealthyDelay() : this.currentBackoffMs;
        this.scheduleNext(next);
      });
    }, delayMs);
  }

  private async runOnce(): Promise<void> {
    try {
      const outcome = await runDriftScan();
      if (outcome.online) {
        this.currentBackoffMs = BACKOFF_INITIAL_MS;
        this.log.info(
          { packages: outcome.report.packages.length },
          'drift scan completed (online)',
        );
      } else {
        this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, BACKOFF_MAX_MS);
        this.log.warn(
          { installedFetchError: outcome.installedFetchError, backoffMs: this.currentBackoffMs },
          'drift scan offline; backing off',
        );
      }
    } catch (err) {
      // The scanner itself catches network errors; this catch is a guardrail
      // against bugs (so a scheduler tick never crashes the Fastify event loop).
      this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, BACKOFF_MAX_MS);
      this.log.error({ err, backoffMs: this.currentBackoffMs }, 'drift scan threw');
    }
  }
}
