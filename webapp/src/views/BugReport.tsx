import { useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Spinner } from 'reactstrap';
import {
  buildGithubIssueUrl,
  downloadBugReport,
  fmtSize,
  saveBlob,
  uploadToFilebin,
  UploadUnconfirmedError,
  type ApiError,
} from '../api';

interface GeneratedReport {
  blob: Blob;
  filename: string;
  sizeBytes: number;
  durationMs: number;
}

// Where bug reports go. Same target as the bash `signalk bug-report`
// helper — most reports surface signalk-server problems even when
// triggered via the Doctor. Future: dropdown to pick a different
// dirkwa/signalk-* repo when the bug is clearly in a peer.
const ISSUE_REPO = 'SignalK/signalk-server';

export function BugReport() {
  const [report, setReport] = useState<GeneratedReport | null>(null);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateErr, setGenerateErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const [filebinUrl, setFilebinUrl] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  async function runGenerate(): Promise<void> {
    setGenerateBusy(true);
    setGenerateErr(null);
    setFilebinUrl(null);
    setUploadErr(null);
    setElapsed(0);
    try {
      const r = await downloadBugReport((s) => setElapsed(s));
      setReport({
        blob: r.blob,
        filename: r.filename,
        sizeBytes: r.sizeBytes,
        durationMs: r.durationMs,
      });
    } catch (err) {
      const apiErr = err as ApiError;
      const lines = [apiErr.message ?? String(err)];
      if (apiErr.body && typeof apiErr.body === 'object' && apiErr.body !== null) {
        const body = apiErr.body as { detail?: string; stderr?: string };
        if (typeof body.detail === 'string') lines.push('', body.detail);
        if (typeof body.stderr === 'string' && body.stderr.trim() !== '') {
          lines.push('', '— stderr —', body.stderr.trim());
        }
      }
      setGenerateErr(lines.join('\n'));
    } finally {
      setGenerateBusy(false);
    }
  }

  function downloadCached(): void {
    if (report === null) return;
    saveBlob(report.filename, report.blob);
  }

  async function runUpload(): Promise<void> {
    if (report === null) return;
    setUploadBusy(true);
    setUploadErr(null);
    try {
      const url = await uploadToFilebin(report.filename, report.blob);
      setFilebinUrl(url);
    } catch (err) {
      if (err instanceof UploadUnconfirmedError) {
        // The bundle itself is fine — it is in the browser and on the host.
        // Only the hop to filebin.net is in doubt, so the actionable answer is
        // the local download, not the error text.
        setUploadErr(
          `${err.message}\n\n` +
            'Usually this means the box has no internet route to filebin.net. The bug report ' +
            'itself was created successfully. Use "Download locally" below to save it and ' +
            'attach it to the issue by hand.\n\n' +
            `It is also on the Signal K host at ~/.signalk-doctor/bug-reports/${report.filename} ` +
            '— fetch it over SSH if this browser cannot save it. Only the newest few bundles ' +
            'are kept, so grab it before running another bug report.',
        );
      } else {
        setUploadErr(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setUploadBusy(false);
    }
  }

  function openIssue(): void {
    if (report === null) return;
    const lines: string[] = [];
    if (filebinUrl !== null) {
      lines.push(`**Bug report bundle:** ${filebinUrl}`);
      lines.push(`_(filebin link, auto-expires in ~6 days — please download soon)_`);
    } else {
      lines.push(`**Bug report bundle:** attach \`${report.filename}\` manually`);
    }
    lines.push('', '**What happened:**', '', '**Expected:**', '', '**Steps to reproduce:**', '');
    const body = lines.join('\n');
    const title = `Bug report ${report.filename.replace(/^signalk-bug-report-/, '').replace(/\.tar\.gz$/, '')}`;
    const url = buildGithubIssueUrl({ repo: ISSUE_REPO, title, body });
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  const seconds = report !== null ? Math.round(report.durationMs / 1000) : 0;

  return (
    <div>
      <Card className="mb-3">
        <CardHeader>
          <strong>Bug report</strong>
        </CardHeader>
        <CardBody>
          <p>
            Bundle host journals, container state, Quadlets, and redacted SignalK config into a
            tarball you can attach to a GitHub issue.
          </p>
          <Alert color="info" className="small mb-3">
            <strong>Privacy:</strong> auth tokens and SignalK plugin config bodies are <em>not</em>{' '}
            included. <code>settings.json</code> is included with <code>pipedProviders</code>{' '}
            options redacted. Container env values in inspect dumps are redacted (keys preserved).
            The bundle still contains hardware info, plugin versions, and ~24 hours of journal
            output — review it before sharing if you have concerns.
          </Alert>
          <ol className="ps-3 mb-0">
            <li className="mb-3">
              <div className="d-flex align-items-center gap-2 flex-wrap">
                <strong>Generate the bundle</strong>
                {report !== null && <Badge color="success">done</Badge>}
              </div>
              <p className="text-muted small mb-2">
                The doctor delegates to the host's <code>signalk bug-report</code> script via{' '}
                <code>systemd-run --user</code>. Can take a couple of minutes on a busy boat.
              </p>
              <Button color="primary" disabled={generateBusy} onClick={() => void runGenerate()}>
                {generateBusy && <Spinner size="sm" className="me-2" />}
                {generateBusy
                  ? elapsed > 0
                    ? `Collecting… ${elapsed}s`
                    : 'Collecting…'
                  : report !== null
                    ? 'Regenerate'
                    : 'Generate bundle'}
              </Button>
              {generateErr !== null && (
                <Alert color="danger" className="mt-2 mb-0">
                  <pre className="mb-0 small">{generateErr}</pre>
                </Alert>
              )}
              {report !== null && (
                <Alert color="success" className="mt-2 mb-0 small">
                  <code>{report.filename}</code> &middot; {fmtSize(report.sizeBytes)} &middot; took{' '}
                  {seconds}s
                  <Button
                    color="link"
                    size="sm"
                    className="ms-2 p-0 align-baseline"
                    onClick={downloadCached}
                  >
                    Download locally
                  </Button>
                </Alert>
              )}
            </li>
            <li className="mb-3">
              <div className="d-flex align-items-center gap-2 flex-wrap">
                <strong>Upload to filebin.net</strong>
                {filebinUrl !== null && <Badge color="success">done</Badge>}
              </div>
              <p className="text-muted small mb-2">
                Upload directly from your browser to <code>filebin.net</code> — a public storage
                service. The bin name is randomised so the URL is unguessable; bins auto-expire in
                ~6 days. Anyone with the URL can download.
              </p>
              <Button
                color="primary"
                disabled={report === null || uploadBusy}
                onClick={() => void runUpload()}
              >
                {uploadBusy && <Spinner size="sm" className="me-2" />}
                {uploadBusy
                  ? 'Uploading…'
                  : filebinUrl !== null
                    ? 'Re-upload'
                    : 'Upload to filebin'}
              </Button>
              {uploadErr !== null && (
                <Alert color="danger" className="mt-2 mb-0">
                  {/* Not a <pre className="text-wrap">: Bootstrap's .text-wrap
                      forces white-space: normal, collapsing the blank lines
                      between paragraphs. Render each one as its own element. */}
                  {uploadErr.split('\n\n').map((para, i) => (
                    <p key={i} className="small mb-2 text-break">
                      {para}
                    </p>
                  ))}
                  {report !== null && (
                    <Button color="primary" size="sm" className="mb-0" onClick={downloadCached}>
                      Download locally
                    </Button>
                  )}
                </Alert>
              )}
              {filebinUrl !== null && (
                <Alert color="success" className="mt-2 mb-0 small">
                  Uploaded:{' '}
                  <a href={filebinUrl} target="_blank" rel="noopener noreferrer">
                    {filebinUrl}
                  </a>
                </Alert>
              )}
            </li>
            <li>
              <div>
                <strong>Open the GitHub issue</strong>
              </div>
              <p className="text-muted small mb-2">
                Opens <code>{ISSUE_REPO}/issues/new</code> in a new tab with the bundle URL and a
                template body pre-filled. If you skipped the upload, the body asks you to attach the
                file manually.
              </p>
              <Button color="primary" disabled={report === null} onClick={openIssue}>
                Open issue ↗
              </Button>
            </li>
          </ol>
        </CardBody>
      </Card>
    </div>
  );
}
