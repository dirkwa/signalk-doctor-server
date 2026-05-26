import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Spinner, Table } from 'reactstrap';
import {
  fmtTime,
  getDrift,
  refreshDrift,
  relTime,
  type ApiError,
  type DriftClassification,
  type DriftReport,
} from '../api';

// Per-classification badge color. Drift severity climbs left-to-right:
// patch/minor/major/prerelease are the "drift" cases — unknown means
// the registry probe hasn't succeeded yet for that package; up-to-date
// is the happy case.
const CLASSIFICATION_COLOR: Record<DriftClassification, string> = {
  'up-to-date': 'success',
  patch: 'info',
  minor: 'warning',
  major: 'danger',
  prerelease: 'secondary',
  unknown: 'secondary',
};

// Ordering for the drifting-first sort: bigger numbers float higher.
const CLASSIFICATION_ORDER: Record<DriftClassification, number> = {
  major: 5,
  minor: 4,
  patch: 3,
  prerelease: 2,
  unknown: 1,
  'up-to-date': 0,
};

function sortBySeverity(packages: DriftReport['packages']): DriftReport['packages'] {
  return [...packages].sort((a, b) => {
    const sev = CLASSIFICATION_ORDER[b.classification] - CLASSIFICATION_ORDER[a.classification];
    if (sev !== 0) return sev;
    return a.name.localeCompare(b.name);
  });
}

export function Drift() {
  const [report, setReport] = useState<DriftReport | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await getDrift();
      setReport(r);
      setLoadErr(null);
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function rescan(): Promise<void> {
    setBusy(true);
    setRefreshErr(null);
    try {
      const r = await refreshDrift();
      setReport(r);
    } catch (err) {
      const lines = ['Rescan failed:'];
      if (err instanceof Error) {
        lines.push(err.message);
        const body = (err as ApiError).body;
        if (body !== undefined && body !== null) {
          lines.push('', JSON.stringify(body, null, 2));
        }
      } else {
        lines.push(String(err));
      }
      setRefreshErr(lines.join('\n'));
    } finally {
      setBusy(false);
    }
  }

  if (loadErr !== null) {
    return (
      <Alert color="danger">
        <strong>Could not load drift report.</strong>
        <pre className="mb-0 small mt-2">{loadErr}</pre>
      </Alert>
    );
  }

  if (report === null) {
    return (
      <div className="text-center py-4">
        <Spinner size="sm" /> <span className="ms-2">Loading…</span>
      </div>
    );
  }

  const sorted = sortBySeverity(report.packages);
  const drifting = report.packages.filter((p) => p.classification !== 'up-to-date');

  return (
    <div>
      <Card className="mb-3">
        <CardHeader className="d-flex justify-content-between align-items-center">
          <strong>Pinned-dependency drift</strong>
          <Button color="primary" size="sm" disabled={busy} onClick={() => void rescan()}>
            {busy && <Spinner size="sm" className="me-2" />}
            {busy ? 'Rescanning…' : 'Rescan now'}
          </Button>
        </CardHeader>
        <CardBody>
          <p>
            Drift between the npm packages baked into the running <code>signalk-server</code> image
            and the latest versions on the npm registry. The doctor reads installed versions from{' '}
            <code>signalk-server</code>'s <code>/skServer/diagnostics</code> endpoint, then queries
            npmjs for each package's latest stable release.
          </p>
          <dl className="row small mb-0">
            <dt className="col-sm-3">SignalK image</dt>
            <dd className="col-sm-9 font-monospace">{report.signalkImageTag ?? '—'}</dd>
            <dt className="col-sm-3">Last scan attempt</dt>
            <dd className="col-sm-9">
              {fmtTime(report.lastScannedAt)}{' '}
              <span className="text-muted">({relTime(report.lastScannedAt) || 'never'})</span>
            </dd>
            <dt className="col-sm-3">Last successful scan</dt>
            <dd className="col-sm-9">
              {report.lastSuccessfulScanAt !== null ? (
                <>
                  {fmtTime(report.lastSuccessfulScanAt)}{' '}
                  <span className="text-muted">({relTime(report.lastSuccessfulScanAt)})</span>
                </>
              ) : (
                <span className="text-muted">never</span>
              )}
            </dd>
            <dt className="col-sm-3">Online</dt>
            <dd className="col-sm-9">
              <Badge color={report.online ? 'success' : 'secondary'} pill>
                {report.online ? 'yes' : 'offline'}
              </Badge>
            </dd>
          </dl>
        </CardBody>
      </Card>

      {refreshErr !== null && (
        <Alert color="danger" className="mb-3">
          <pre className="mb-0 small">{refreshErr}</pre>
        </Alert>
      )}

      <Card>
        <CardHeader className="d-flex justify-content-between align-items-center">
          <strong>Packages</strong>
          <span className="text-muted small">
            {drifting.length === 0
              ? `${report.packages.length} tracked, all up to date`
              : `${drifting.length} drifting / ${report.packages.length} tracked`}
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {report.packages.length === 0 ? (
            <p className="text-muted small p-3 mb-0">
              No tracked packages reported. signalk-server may be unreachable, or its{' '}
              <code>/skServer/diagnostics</code> endpoint may not be available — check the Health
              tab for the <em>signalk-server</em> probe.
            </p>
          ) : (
            <Table responsive size="sm" className="mb-0">
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Installed</th>
                  <th>Latest</th>
                  <th>Status</th>
                  <th>Last fetched</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <tr key={p.name}>
                    <td className="font-monospace small">{p.name}</td>
                    <td className="font-monospace small">{p.installed}</td>
                    <td className="font-monospace small">{p.latest ?? '—'}</td>
                    <td>
                      <Badge color={CLASSIFICATION_COLOR[p.classification]} pill>
                        {p.classification}
                      </Badge>
                    </td>
                    <td className="text-muted small">
                      {p.lastFetchedAt !== null ? relTime(p.lastFetchedAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
