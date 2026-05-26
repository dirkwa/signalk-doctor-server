import { useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, Spinner } from 'reactstrap';
import {
  downloadBugReport,
  fmtSize,
  recoverAll,
  recoverUpdater,
  saveBlob,
  type ApiError,
} from '../api';
import { ConfirmModal } from '../components/ConfirmModal';

type Target = 'all' | 'updater';

interface PendingConfirm {
  target: Target;
  title: string;
  body: string;
  okLabel: string;
}

const PROMPTS: Record<Target, Omit<PendingConfirm, 'target'>> = {
  all: {
    title: 'Recover all to last-known-good?',
    body: 'This will roll signalk-server AND signalk-updater-server back to their last-known-good Quadlets, daemon-reload, and restart both. Expect 30–60s of downtime.',
    okLabel: 'Recover',
  },
  updater: {
    title: 'Recover updater only?',
    body: 'This restores signalk-updater-server.container from last-known-good and restarts the updater. signalk-server is not touched.',
    okLabel: 'Recover updater',
  },
};

export function Recover() {
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [busy, setBusy] = useState<Target | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [resultKind, setResultKind] = useState<'ok' | 'err' | null>(null);

  const [bugReportBusy, setBugReportBusy] = useState(false);
  const [bugReportResult, setBugReportResult] = useState<{
    kind: 'ok' | 'err';
    message: string;
  } | null>(null);

  async function runBugReport(): Promise<void> {
    setBugReportBusy(true);
    setBugReportResult({
      kind: 'ok',
      message: 'Collecting diagnostics — this can take up to a few minutes…',
    });
    try {
      const r = await downloadBugReport();
      saveBlob(r.filename, r.blob);
      const seconds = Math.round(r.durationMs / 1000);
      setBugReportResult({
        kind: 'ok',
        message: `Downloaded ${r.filename} (${fmtSize(r.sizeBytes)}, took ${seconds}s).`,
      });
    } catch (err) {
      const apiErr = err as ApiError;
      const lines = ['Bug report failed:', apiErr.message];
      if (apiErr.body && typeof apiErr.body === 'object' && apiErr.body !== null) {
        // Surface stderr from the host script so the operator can see
        // what the bash side complained about — most failures here are
        // "host-script-missing" or "unsupported-flag" and the detail
        // tells them exactly which "signalk update" / installer rerun
        // would fix it.
        const body = apiErr.body as { detail?: string; stderr?: string };
        if (typeof body.detail === 'string') lines.push('', body.detail);
        if (typeof body.stderr === 'string' && body.stderr.trim() !== '') {
          lines.push('', '— stderr —', body.stderr.trim());
        }
      }
      setBugReportResult({ kind: 'err', message: lines.join('\n') });
    } finally {
      setBugReportBusy(false);
    }
  }

  function askConfirm(target: Target): void {
    setConfirm({ target, ...PROMPTS[target] });
  }

  async function execute(target: Target): Promise<void> {
    setBusy(target);
    setResult(`Recovering ${target}…`);
    setResultKind(null);
    try {
      const out = await (target === 'all' ? recoverAll() : recoverUpdater());
      setResult(JSON.stringify(out, null, 2));
      setResultKind('ok');
    } catch (err) {
      const lines = [`Recovery (${target}) failed:`];
      if (err instanceof Error) {
        lines.push(err.message);
        const body = (err as ApiError).body;
        if (body !== undefined && body !== null) {
          lines.push('', JSON.stringify(body, null, 2));
        }
      } else {
        lines.push(String(err));
      }
      setResult(lines.join('\n'));
      setResultKind('err');
    } finally {
      setBusy(null);
    }
  }

  function onConfirm(): void {
    if (!confirm) return;
    const target = confirm.target;
    setConfirm(null);
    void execute(target);
  }

  return (
    <div>
      <Card className="mb-3">
        <CardHeader>
          <strong>Recovery</strong>
        </CardHeader>
        <CardBody>
          <p>
            Recovery rolls every managed Quadlet back to its last-known-good snapshot, runs{' '}
            <code>systemctl --user daemon-reload</code>, and restarts both{' '}
            <code>signalk-server</code> and <code>signalk-updater-server</code>. This is the
            out-of-band path back when the updater can't help itself.
          </p>
          <p className="text-muted small">
            Before clicking <strong>Recover all</strong>, open the Snapshots tab and check that the{' '}
            <em>last-known-good</em> entries point to versions you actually trust.
          </p>
          <div className="d-flex gap-2 flex-wrap">
            <Button
              color="danger"
              disabled={busy !== null}
              onClick={() => {
                askConfirm('all');
              }}
            >
              Recover all (server + updater)
            </Button>
            <Button
              color="secondary"
              outline
              disabled={busy !== null}
              onClick={() => {
                askConfirm('updater');
              }}
            >
              Recover updater only
            </Button>
          </div>
          {result !== null && (
            <Alert
              color={resultKind === 'ok' ? 'success' : resultKind === 'err' ? 'danger' : 'info'}
              className="mt-3 mb-0"
            >
              <pre className="mb-0 small">{result}</pre>
            </Alert>
          )}
        </CardBody>
      </Card>

      <Card className="mb-3">
        <CardHeader>
          <strong>Bug report</strong>
        </CardHeader>
        <CardBody>
          <p>
            Bundle host journals, container state, Quadlets, and redacted SignalK config into a
            tarball you can attach to an issue. Auth tokens and plugin config bodies are not
            included; <code>settings.json</code> is included with <code>pipedProviders</code>{' '}
            options redacted.
          </p>
          <p className="text-muted small">
            The doctor delegates to the host <code>signalk bug-report</code> script over its DBus
            mount, so the result is byte-for-byte the same bundle{' '}
            <code>ssh + signalk bug-report</code> produces. Saved to your browser's Downloads
            folder; the last few bundles are also kept on the host under{' '}
            <code>~/.signalk-doctor/bug-reports/</code>.
          </p>
          <Button color="primary" disabled={bugReportBusy} onClick={() => void runBugReport()}>
            {bugReportBusy && <Spinner size="sm" className="me-2" />}
            {bugReportBusy ? 'Generating…' : 'Generate bug report'}
          </Button>
          {bugReportResult !== null && (
            <Alert color={bugReportResult.kind === 'ok' ? 'info' : 'danger'} className="mt-3 mb-0">
              <pre className="mb-0 small">{bugReportResult.message}</pre>
            </Alert>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <strong>Host-side safety net</strong>
        </CardHeader>
        <CardBody>
          <p>
            If both this Doctor and the Updater are dead, log in over SSH and run the installer's
            recovery script:
          </p>
          <pre className="bg-body-tertiary p-2 rounded small mb-2">
            <code>
              ~/.local/bin/signalk-recovery status{'\n'}~/.local/bin/signalk-recovery rollback-all
            </code>
          </pre>
          <p className="text-muted small mb-0">
            That script is a pure-bash sibling of the doctor — same Quadlet snapshots, no container
            dependencies.
          </p>
        </CardBody>
      </Card>

      <ConfirmModal
        isOpen={confirm !== null}
        title={confirm?.title ?? ''}
        body={confirm?.body ?? ''}
        okLabel={confirm?.okLabel ?? 'OK'}
        okColor={confirm?.target === 'all' ? 'danger' : 'primary'}
        onConfirm={onConfirm}
        onCancel={() => {
          setConfirm(null);
        }}
      />
    </div>
  );
}
