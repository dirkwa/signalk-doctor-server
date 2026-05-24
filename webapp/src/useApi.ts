import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Fetch + auto-refresh wrapper for a single API endpoint. Cancels in-
// flight requests on unmount so React doesn't warn about state updates
// after unmount, and keeps the previous data visible across refreshes
// (no flicker between "loading" and "loaded again").
export function useApi<T>(
  fetcher: () => Promise<T>,
  options: { intervalMs?: number; paused?: boolean } = {},
): UseApiState<T> {
  const { intervalMs, paused = false } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stable ref to the latest fetcher so the interval doesn't reset
  // every render (we'd otherwise tear down + rebuild the timer on each
  // parent rerender).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const tick = useCallback(async (cancelled: { current: boolean }) => {
    try {
      const result = await fetcherRef.current();
      if (cancelled.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (cancelled.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, []);

  const [refreshCounter, setRefreshCounter] = useState(0);
  const refresh = useCallback(() => {
    setRefreshCounter((c) => c + 1);
  }, []);

  useEffect(() => {
    const cancelled = { current: false };
    setLoading(true);
    void tick(cancelled);
    let timer: ReturnType<typeof setInterval> | undefined;
    if (intervalMs && intervalMs > 0 && !paused) {
      timer = setInterval(() => {
        void tick(cancelled);
      }, intervalMs);
    }
    return () => {
      cancelled.current = true;
      if (timer) clearInterval(timer);
    };
  }, [intervalMs, paused, tick, refreshCounter]);

  return { data, loading, error, refresh };
}
