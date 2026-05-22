export type ProbeStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface ProbeResult {
  id: string;
  label: string;
  status: ProbeStatus;
  message: string;
  details?: Record<string, unknown>;
  durationMs: number;
}
