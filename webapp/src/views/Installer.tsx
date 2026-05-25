import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Table } from 'reactstrap';
import {
  getInstallerStatus,
  refreshInstaller,
  type ApiError,
  type InstallerArtifactStatus,
  type InstallerRefreshResponse,
  type InstallerStatusResponse,
} from '../api';
import { ConfirmModal } from '../components/ConfirmModal';
import { fmtTime, relTime } from '../api';

const STATUS_COLOR: Record<InstallerArtifactStatus, string> = {
  updated: 'success',
  unchanged: 'secondary',
  'mount-missing': 'warning',
  'fetch-failed': 'danger',
  'write-failed': 'danger',
};

const CONFIRM_BODY =
  'This fetches the latest install-signalk-command.sh, signalk-recovery.tmpl, detect-hardware.sh, ' +
  'and the three Quadlet templates from GitHub Pages. The host scripts at ~/.local/bin/signalk and ' +
  'signalk-recovery will be overwritten — prior contents are snapshotted under ' +
  '~/.signalk-doctor/installer-snapshots/ first. No containers are restarted; ' +
  'no Quadlets are applied. This is a forward-only refresh.';

export function Installer() {
  const [status, setStatus] = useState<InstallerStatusResponse | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<InstallerRefreshResponse | null>(null);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const s = await getInstallerStatus();
      setStatus(s);
      setStatusErr(null);
    } catch (err) {
      setStatusErr(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function execute(): Promise<void> {
    setBusy(true);
    setRefreshErr(null);
    try {
      const out = await refreshInstaller();
      setLastRefresh(out);
      // Reload status so artifact mtimes and hashes reflect the writes.
      await loadStatus();
    } catch (err) {
      const lines = ['Refresh failed:'];
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

  return (
    <div>
      <Card className="mb-3">
        <CardHeader className="d-flex justify-content-between align-items-center">
          <strong>Installer refresh</strong>
          {status !== null && !status.hostBinMounted && (
            <Badge color="warning">~/.local/bin not mounted</Badge>
          )}
        </CardHeader>
        <CardBody>
          <p>
            Pulls the latest bash installer payload from GitHub Pages and rewrites the host-side{' '}
            <code>signalk</code> CLI, <code>signalk-recovery</code> script, and Quadlet templates.
            Use this when <code>signalk help</code> is stale relative to what the universal
            installer publishes — you do <strong>not</strong> need to SSH and re-run the{' '}
            <code>curl … | bash</code> one-liner for these scripts.
          </p>
          {status !== null && !status.hostBinMounted && (
            <Alert color="warning" className="small">
              The <code>~/.local/bin</code> bind mount is not present on this doctor container —
              host-script writes will be reported as <code>mount-missing</code>. Re-run the bash
              installer once to add the mount, then come back to this page.
            </Alert>
          )}
          <p className="text-muted small mb-3">
            Source: <code>{status?.pagesBase ?? '—'}</code>
          </p>
          <Button
            color="primary"
            disabled={busy}
            onClick={() => {
              setConfirmOpen(true);
            }}
          >
            {busy ? 'Refreshing…' : 'Refresh installer'}
          </Button>
          {refreshErr !== null && (
            <Alert color="danger" className="mt-3 mb-0">
              <pre className="mb-0 small">{refreshErr}</pre>
            </Alert>
          )}
          {lastRefresh !== null && (
            <Alert color="success" className="mt-3 mb-0">
              <div className="small">
                <strong>Refresh complete</strong> — {fmtTime(lastRefresh.finishedAt)} (
                {Object.entries(lastRefresh.counts)
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => `${n} ${k}`)
                  .join(', ')}
                )
              </div>
              <Table size="sm" className="mt-2 mb-0">
                <thead>
                  <tr>
                    <th>Artifact</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {lastRefresh.results.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <code>{r.id}</code>
                      </td>
                      <td>
                        <Badge color={STATUS_COLOR[r.status]}>{r.status}</Badge>
                      </td>
                      <td className="small">{r.message ?? r.sha256?.slice(0, 12) ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Alert>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <strong>Current state</strong>
        </CardHeader>
        <CardBody>
          {statusErr !== null && (
            <Alert color="danger" className="small">
              {statusErr}
            </Alert>
          )}
          {status === null && statusErr === null && <p className="text-muted">Loading…</p>}
          {status !== null && (
            <Table size="sm" responsive className="mb-0">
              <thead>
                <tr>
                  <th>Artifact</th>
                  <th>Kind</th>
                  <th>Path</th>
                  <th>Updated</th>
                  <th>SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {status.artifacts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <code>{a.id}</code>
                    </td>
                    <td className="small text-muted">{a.kind}</td>
                    <td className="small">
                      <code>{a.destPath}</code>
                    </td>
                    <td className="small">
                      {a.present ? (
                        <span title={a.mtime ?? ''}>{relTime(a.mtime)}</span>
                      ) : (
                        <span className="text-muted">never</span>
                      )}
                    </td>
                    <td className="small font-monospace">{a.sha256?.slice(0, 12) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <ConfirmModal
        isOpen={confirmOpen}
        title="Refresh the installer payload?"
        body={CONFIRM_BODY}
        okLabel="Refresh"
        okColor="primary"
        onConfirm={() => {
          setConfirmOpen(false);
          void execute();
        }}
        onCancel={() => {
          setConfirmOpen(false);
        }}
      />
    </div>
  );
}
