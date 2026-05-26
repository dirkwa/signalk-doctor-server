import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Spinner, Table } from 'reactstrap';
import {
  fmtTime,
  getDrift,
  refreshDrift,
  relTime,
  type ApiError,
  type DriftClassification,
  type DriftFetchError,
  type DriftReport,
} from '../api';

/** Reason-specific guidance for the "Online: offline" failure modes.
 *  Each entry: short label for the inline badge, a longer "what to do
 *  about it" body for the alert under the header. Kept here so the
 *  copy review can sit next to the component. */
const FETCH_ERROR_GUIDANCE: Record<
  DriftFetchError['reason'],
  { label: string; color: string; title: string; body: React.ReactNode }
> = {
  'no-token': {
    label: 'no admin token',
    color: 'warning',
    title: 'No signalk-server admin token at /data/signalk-token',
    body: (
      <>
        The doctor's drift scanner needs an admin token to call signalk-server's{' '}
        <code>/skServer/diagnostics</code> endpoint. The bash installer's step{' '}
        <code>15b. Doctor admin token</code> writes this file. Re-run the universal installer (or
        run <code>signalk update</code> on the host) to provision it; if signalk-server's security
        isn't enabled yet, enable it in the admin UI first.
      </>
    ),
  },
  auth: {
    label: '401/403',
    color: 'danger',
    title: 'signalk-server rejected the admin token',
    body: (
      <>
        The token at <code>~/.signalk-doctor/signalk-token</code> is invalid or expired. Regenerate
        it on the host:
        <pre className="bg-body-tertiary p-2 rounded small mt-2 mb-0">
          podman exec signalk-server \\
          <br />
          /home/node/signalk/node_modules/signalk-server/bin/signalk-generate-token \\
          <br />
          -u admin -e 5y -s /home/node/.signalk/security.json \\
          <br />
          {'>'} ~/.signalk-doctor/signalk-token
        </pre>
      </>
    ),
  },
  network: {
    label: 'unreachable',
    color: 'danger',
    title: 'signalk-server is unreachable',
    body: (
      <>
        The doctor couldn't open a TCP connection to signalk-server at all. Check the{' '}
        <strong>Health</strong> tab's <em>signalk-server</em> probe — if it's red, restart the
        container from the Updater Console or via{' '}
        <code>systemctl --user restart signalk-server.service</code>.
      </>
    ),
  },
  'not-found': {
    label: '404',
    color: 'warning',
    title: 'signalk-server doesn’t have /skServer/diagnostics',
    body: (
      <>
        The diagnostics endpoint landed upstream in{' '}
        <a
          href="https://github.com/SignalK/signalk-server/pull/2702"
          target="_blank"
          rel="noopener noreferrer"
        >
          SignalK PR #2702
        </a>
        . The currently-running signalk-server image predates that. Switch to a newer image via the
        Updater Console's <strong>Versions</strong> tab (the <code>:dirkwa</code> channel already
        has it).
      </>
    ),
  },
  http: {
    label: 'HTTP error',
    color: 'danger',
    title: 'signalk-server returned a non-OK status',
    body: (
      <>Generic HTTP failure — see the detail line below for the exact code, and the Logs tab.</>
    ),
  },
  'bad-payload': {
    label: 'malformed',
    color: 'warning',
    title: 'signalk-server returned an unexpected response shape',
    body: (
      <>
        The diagnostics endpoint replied with something other than the expected{' '}
        <code>{'{ packages: [...] }'}</code> envelope. The Drift feature targets the upstream PR
        #2702 contract; a custom signalk-server fork that overrides this route would need to match
        it.
      </>
    ),
  },
};

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
              {report.lastFetchError !== null ? (
                <Badge
                  color={FETCH_ERROR_GUIDANCE[report.lastFetchError.reason].color}
                  pill
                  title={report.lastFetchError.detail}
                >
                  {FETCH_ERROR_GUIDANCE[report.lastFetchError.reason].label}
                </Badge>
              ) : (
                <Badge color={report.online ? 'success' : 'secondary'} pill>
                  {report.online ? 'yes' : 'offline'}
                </Badge>
              )}
            </dd>
          </dl>
        </CardBody>
      </Card>

      {report.lastFetchError !== null && (
        <Alert color={FETCH_ERROR_GUIDANCE[report.lastFetchError.reason].color} className="mb-3">
          <h6 className="alert-heading mb-2">
            {FETCH_ERROR_GUIDANCE[report.lastFetchError.reason].title}
          </h6>
          <div className="mb-2">{FETCH_ERROR_GUIDANCE[report.lastFetchError.reason].body}</div>
          <hr />
          <p className="mb-0 small text-muted font-monospace">{report.lastFetchError.detail}</p>
        </Alert>
      )}

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
              {report.lastFetchError !== null
                ? 'No package data yet — see the diagnostic alert above for the next step.'
                : 'No tracked packages reported. The scan completed without an error, but signalk-server returned an empty packages array.'}
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
