import { Alert, Button, Spinner } from 'reactstrap';
import { getProbes, fmtTime, relTime, type ProbeStatus } from '../api';
import { useApi } from '../useApi';
import { ProbeCard } from '../components/ProbeCard';
import { StatusPill } from '../components/StatusPill';

const STATUS_ORDER: Record<ProbeStatus, number> = { fail: 0, warn: 1, unknown: 2, ok: 3 };

export function Health() {
  const { data, loading, error, refresh } = useApi(getProbes, { intervalMs: 15_000 });

  const sorted = data
    ? [...data.results].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    : [];

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          {data && (
            <>
              <StatusPill status="ok" count={data.summary.ok} label="ok" />
              <StatusPill status="warn" count={data.summary.warn} label="warn" />
              <StatusPill status="fail" count={data.summary.fail} label="fail" />
              <StatusPill status="unknown" count={data.summary.unknown} label="unknown" />
            </>
          )}
        </div>
        <Button color="secondary" outline size="sm" onClick={refresh} disabled={loading}>
          {loading ? <Spinner size="sm" /> : 'Re-run'}
        </Button>
      </div>

      {data && (
        <p className="text-muted small mb-3">
          Ran at {fmtTime(data.ranAt)} ({relTime(data.ranAt)}) · {data.durationMs}ms ·{' '}
          {data.results.length} probes
        </p>
      )}

      {error && <Alert color="danger">Failed to run probes: {error}</Alert>}

      {loading && !data && (
        <div className="text-center my-4">
          <Spinner /> <span className="ms-2 text-muted">Running probes…</span>
        </div>
      )}

      {sorted.map((probe) => (
        <ProbeCard key={probe.id} probe={probe} />
      ))}
    </div>
  );
}
