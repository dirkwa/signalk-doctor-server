import { useCallback, useEffect, useRef, useState } from 'react';
import { logsStreamUrl } from './api';

export type LogStatus = 'connecting' | 'connected' | 'paused' | 'error' | 'disconnected';

export interface ParsedLogLine {
  /** Sequential id used as a stable React key. */
  id: number;
  /** ISO timestamp if we could extract one from the line, else null. */
  time: string | null;
  /** Lower-case level like info/warn/error/debug/trace/fatal, or '' when unknown. */
  level: string;
  /** Cleaned-up message text (Pino fields collapsed, ISO prefix stripped, …). */
  message: string;
  /** Original raw line as the server sent it. */
  raw: string;
}

interface UseLogStreamOptions {
  containerName: string;
  tail: number;
  /** When `enabled` is false the hook tears down any active EventSource. */
  enabled: boolean;
}

interface UseLogStreamReturn {
  lines: ParsedLogLine[];
  status: LogStatus;
  paused: boolean;
  togglePause: () => void;
  clear: () => void;
}

const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};
const LEVEL_RX_PINO = /"level":(\d+)/;
const LEVEL_RX_WORD = /\b(trace|debug|info|warn(?:ing)?|error|fatal)\b/i;
const TS_RX_FRONT = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*/;
const TS_RX_PINO = /"time":(\d{10,13})/;
const MAX_BUFFER = 2000;

export function parseLogLine(raw: string, id: number): ParsedLogLine {
  if (!raw) return { id, time: null, level: '', message: '', raw };
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const lvlNum = obj.level;
      let level = '';
      if (typeof lvlNum === 'number' && PINO_LEVELS[lvlNum]) {
        level = PINO_LEVELS[lvlNum];
      } else if (typeof lvlNum === 'string') {
        level = lvlNum;
      }
      let time: string | null = null;
      if (typeof obj.time === 'number') time = new Date(obj.time).toISOString();
      else if (typeof obj.time === 'string') time = new Date(Number(obj.time)).toISOString();
      const msg =
        typeof obj.msg === 'string' ? obj.msg : typeof obj.message === 'string' ? obj.message : '';
      const extras = Object.entries(obj)
        .filter(([k]) => !['level', 'time', 'msg', 'message', 'hostname', 'pid', 'v'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      return { id, time, level, message: extras ? `${msg} ${extras}` : msg, raw };
    } catch {
      // not JSON — fall through to plain-text parsing
    }
  }
  let line = raw;
  let time: string | null = null;
  const tsMatch = line.match(TS_RX_FRONT);
  if (tsMatch && tsMatch[1] !== undefined) {
    time = tsMatch[1];
    line = line.slice(tsMatch[0].length);
  } else {
    const pinoTs = line.match(TS_RX_PINO);
    if (pinoTs && pinoTs[1] !== undefined) {
      time = new Date(Number(pinoTs[1])).toISOString();
    }
  }
  let level = '';
  const lvlMatch = line.match(LEVEL_RX_WORD);
  if (lvlMatch && lvlMatch[1] !== undefined) {
    level = lvlMatch[1].toLowerCase().replace('warning', 'warn');
  }
  if (!level) {
    const num = line.match(LEVEL_RX_PINO);
    if (num && num[1] !== undefined) {
      const lvlNum = Number(num[1]);
      level = PINO_LEVELS[lvlNum] ?? '';
    }
  }
  return { id, time, level, message: line, raw };
}

export function useLogStream(opts: UseLogStreamOptions): UseLogStreamReturn {
  const { containerName, tail, enabled } = opts;
  const [lines, setLines] = useState<ParsedLogLine[]>([]);
  const [status, setStatus] = useState<LogStatus>('disconnected');
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(typeof document === 'undefined' ? true : !document.hidden);

  // pausedRef lets the EventSource onmessage closure read the latest value
  // without resubscribing every time the user toggles pause.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const idCounter = useRef(0);

  const togglePause = useCallback(() => {
    setPaused((p) => !p);
  }, []);

  const clear = useCallback(() => {
    setLines([]);
  }, []);

  // Track document visibility — auto-suspend SSE when the tab is hidden so
  // we don't pay for DOM updates the user can't see. The broker keeps
  // running server-side; reconnecting backfills via the broker's ring.
  useEffect(() => {
    const onVis = (): void => {
      setVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Reflect paused status into the pill when no other state takes priority.
  useEffect(() => {
    if (paused) setStatus('paused');
  }, [paused]);

  // The actual EventSource lifecycle. Restarts whenever the container,
  // tail count, enable flag, or visibility changes — broker backfill makes
  // each new connection seamless.
  useEffect(() => {
    if (!enabled || !visible) {
      setStatus('disconnected');
      return;
    }
    setLines([]);
    setStatus('connecting');
    const url = logsStreamUrl(containerName, tail);
    const es = new EventSource(url);

    const onOpen = (): void => {
      setStatus(pausedRef.current ? 'paused' : 'connected');
    };
    const onMessage = (ev: MessageEvent<string>): void => {
      if (pausedRef.current) return;
      idCounter.current += 1;
      const parsed = parseLogLine(ev.data, idCounter.current);
      setLines((prev) => {
        const next = prev.length >= MAX_BUFFER ? prev.slice(prev.length - MAX_BUFFER + 1) : prev;
        return [...next, parsed];
      });
    };
    const onEnd = (ev: MessageEvent<string>): void => {
      idCounter.current += 1;
      setLines((prev) => [
        ...prev,
        {
          id: idCounter.current,
          time: null,
          level: '',
          message: `[stream ended: ${ev.data || 'closed'}]`,
          raw: '',
        },
      ]);
      es.close();
      setStatus('disconnected');
    };
    const onError = (): void => {
      // EventSource auto-reconnects on transient errors; the status pill
      // flips back to 'connected' via onopen when it succeeds.
      setStatus('error');
    };

    es.addEventListener('open', onOpen);
    es.addEventListener('message', onMessage);
    es.addEventListener('end', onEnd as EventListener);
    es.addEventListener('error', onError);

    return () => {
      es.removeEventListener('open', onOpen);
      es.removeEventListener('message', onMessage);
      es.removeEventListener('end', onEnd as EventListener);
      es.removeEventListener('error', onError);
      es.close();
      setStatus('disconnected');
    };
  }, [containerName, tail, enabled, visible]);

  return { lines, status, paused, togglePause, clear };
}
