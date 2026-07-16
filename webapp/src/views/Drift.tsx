import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Spinner, Table } from 'reactstrap';
import {
  explainDrift,
  fmtTime,
  getDrift,
  refreshDrift,
  runDriftHeal,
  relTime,
  type ApiError,
  type DriftClassification,
  type DriftFetchError,
  type DriftLocation,
  type DriftPackage,
  type DriftReport,
  type HealResult,
  type PackageDependent,
  type PackageExplanation,
} from '../api';
import { ConfirmModal } from '../components/ConfirmModal';

/** Reason-specific guidance for the "Online: offline" failure modes.
 *  Each entry: short label for the inline badge, a longer "what to do
 *  about it" body for the alert under the header. Kept here so the
 *  copy review can sit next to the component. */
const FETCH_ERROR_GUIDANCE: Record<
  DriftFetchError['reason'],
  { label: string; color: string; title: string; body: React.ReactNode }
> = {
  unreachable: {
    label: 'unreachable',
    color: 'danger',
    title: 'Cannot reach the signalk-server container',
    body: (
      <>
        The doctor reads installed versions directly from the running <code>signalk-server</code>{' '}
        container's filesystem — no API call, no token. It couldn't reach the container runtime at
        all. Check the <strong>Health</strong> tab's <em>containers</em> and <em>podman</em> probes;
        if signalk-server is down, restart it from the Updater Console or via{' '}
        <code>systemctl --user restart signalk-server.service</code>.
      </>
    ),
  },
  runtime: {
    label: 'read failed',
    color: 'danger',
    title: 'Could not read package versions from the container',
    body: (
      <>
        The container runtime errored while reading <code>package.json</code> files from
        signalk-server — see the detail line below. Check the podman socket mount and the{' '}
        <strong>Health</strong> tab's <em>podman</em> probe.
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

/** The more severe of a package's two location classifications. A package
 *  with no resolved location at all (e.g. right after a report-format
 *  migration, before the next scan) counts as unknown. */
function worstClassification(p: DriftPackage): DriftClassification {
  const locations = [p.image, p.dataDir].filter((l): l is DriftLocation => l !== null);
  if (locations.length === 0) return 'unknown';
  return locations.reduce((worst, l) =>
    CLASSIFICATION_ORDER[l.classification] > CLASSIFICATION_ORDER[worst.classification] ? l : worst,
  ).classification;
}

function sortBySeverity(packages: DriftReport['packages']): DriftReport['packages'] {
  return [...packages].sort((a, b) => {
    const sev =
      CLASSIFICATION_ORDER[worstClassification(b)] - CLASSIFICATION_ORDER[worstClassification(a)];
    if (sev !== 0) return sev;
    return a.name.localeCompare(b.name);
  });
}

/** True when the package's data-dir (plugin tree) copy is behind and a
 *  range-respecting `npm update` could move it. Mirrors the engine's
 *  selectHealTargets(). */
function isHealable(p: DriftPackage): boolean {
  const c = p.dataDir?.classification;
  return c === 'patch' || c === 'minor' || c === 'major';
}

const OUTCOME_PRESENTATION = {
  updated: { color: 'success', label: 'updated' },
  'range-limited': { color: 'warning', label: 'range-limited' },
  unchanged: { color: 'secondary', label: 'unchanged' },
} as const;

function dependentLabel(d: PackageDependent): string {
  const version = d.version !== null ? `@${d.version}` : '';
  return `${d.name}${version} (${d.spec})`;
}

/** The "who holds this back" sentence for a non-updated outcome or a
 *  why?-lookup: names the dependents and their declared ranges, then one
 *  guidance sentence per KIND of holder — plugins (App-Store update), the
 *  data dir's own package.json pin (edit/remove the entry), and the
 *  leftover embedded signalk-server (removable, waiting on no one). Mixed
 *  holders get every applicable sentence, not just the first match. */
function HeldByNote({
  dependents,
  embeddedServer,
}: {
  dependents: PackageDependent[];
  embeddedServer: boolean;
}) {
  if (dependents.length === 0) return null;
  const rootPin = dependents.some((d) => d.name === 'package.json');
  const plugins = dependents.filter(
    (d) => d.name !== 'package.json' && d.name !== 'signalk-server',
  );
  return (
    <span className="text-muted">
      {' '}
      — held by <span className="font-monospace">{dependents.map(dependentLabel).join(', ')}</span>.
      {plugins.length > 0 && (
        <>
          {' '}
          Update the holding plugin{plugins.length === 1 ? '' : 's'} via the App Store once a
          release widens the range.
        </>
      )}
      {rootPin && (
        <>
          {' '}
          The <span className="font-monospace">package.json</span> holder is a direct pin in the
          data dir itself — loosen or remove that entry (<code>npm uninstall &lt;package&gt;</code>{' '}
          drops it).
        </>
      )}
      {embeddedServer && (
        <>
          {' '}
          <strong>The leftover embedded signalk-server</strong> is a pre-container server-update
          artifact, never executed in the container stack — remove it with{' '}
          <code>npm uninstall signalk-server</code> in the data dir to free its pins (and disk).
        </>
      )}
    </span>
  );
}

/** What the heal actually did, package by package, with the honest
 *  residue story: range-limited copies wait on a plugin author's range
 *  bump, not on the operator. */
function HealOutcome({ result, onDismiss }: { result: HealResult; onDismiss: () => void }) {
  const packages = result.ok ? result.packages : (result.packages ?? []);
  const updated = packages.filter((p) => p.outcome === 'updated');
  const limited = packages.filter((p) => p.outcome === 'range-limited');
  const color = !result.ok ? 'danger' : limited.length > 0 ? 'warning' : 'success';
  const nothingToDo = result.ok && result.targets.length === 0;

  return (
    <Alert color={color} className="mb-3" toggle={onDismiss}>
      <h6 className="alert-heading mb-2">
        {!result.ok
          ? 'Plugin-dependency update failed'
          : nothingToDo
            ? 'Nothing to update'
            : 'Plugin-dependency update finished'}
      </h6>
      {!result.ok && <p className="mb-2 small">{result.detail}</p>}
      {!result.ok && result.lockRetained && (
        <p className="mb-2 small">
          <strong>The operation lock is still held</strong> because npm could not be proven stopped.
          Wait for it to finish (rescan to watch the versions settle), or force-clear the lock from
          the Recovery tab only after confirming the process has ended.
        </p>
      )}
      {nothingToDo && (
        <p className="mb-0 small">No drifting plugin dependencies in the data dir.</p>
      )}
      {packages.length > 0 && (
        <ul className="small mb-2">
          {packages.map((p) => (
            <li key={p.name}>
              <span className="font-monospace">{p.name}</span>{' '}
              <Badge color={OUTCOME_PRESENTATION[p.outcome].color} pill>
                {OUTCOME_PRESENTATION[p.outcome].label}
              </Badge>{' '}
              {p.outcome === 'updated' ? (
                <span className="font-monospace">
                  {p.from} → {p.to ?? (p.wasExtraneous ? 'removed (leftover)' : 'hoisted away')}
                </span>
              ) : (
                <>
                  <span className="font-monospace">stays {p.from}</span>
                  {p.outcome === 'range-limited' &&
                    (p.heldBy && p.heldBy.length > 0 ? (
                      <HeldByNote
                        dependents={p.heldBy}
                        embeddedServer={p.heldByEmbeddedServer === true}
                      />
                    ) : (
                      <span className="text-muted">
                        {' '}
                        — newest the plugins&apos; declared ranges allow (latest is{' '}
                        <span className="font-monospace">{p.latest ?? '?'}</span>)
                      </span>
                    ))}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {updated.length > 0 && (
        <p className="mb-2 small">
          <strong>Restart signalk-server</strong> so plugins reload the updated dependencies (via
          the Updater Console or <code>signalk restart</code>).
        </p>
      )}
      {'outputTail' in result && result.outputTail && (
        <details className="small">
          <summary>npm output</summary>
          <pre className="mb-0 mt-2">{result.outputTail}</pre>
        </details>
      )}
    </Alert>
  );
}

/** Version + classification badge for one location; a plain dash when the
 *  package has no copy at that location. Only user-install cells ever get
 *  `onWhy`: the image column's drift has exactly one remedy (a newer
 *  image), so a dependents lookup would answer a question nobody can act
 *  on there. */
function LocationCell({
  location,
  onWhy,
  whyBusy,
}: {
  location: DriftLocation | null;
  onWhy?: () => void;
  whyBusy?: boolean;
}) {
  if (location === null) {
    return <td className="text-muted small">—</td>;
  }
  return (
    <td className="font-monospace small text-nowrap">
      {location.installed}{' '}
      <Badge color={CLASSIFICATION_COLOR[location.classification]} pill>
        {location.classification}
      </Badge>
      {onWhy && (
        <Button
          color="link"
          size="sm"
          className="p-0 ms-2 align-baseline"
          onClick={onWhy}
          disabled={whyBusy === true}
        >
          {whyBusy === true ? <Spinner size="sm" /> : 'why?'}
        </Button>
      )}
    </td>
  );
}

export function Drift() {
  const [report, setReport] = useState<DriftReport | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const [confirmHeal, setConfirmHeal] = useState(false);
  const [healBusy, setHealBusy] = useState(false);
  const [healElapsed, setHealElapsed] = useState(0);
  const [healResult, setHealResult] = useState<HealResult | null>(null);
  const [healErr, setHealErr] = useState<string | null>(null);
  const [whyBusy, setWhyBusy] = useState<string | null>(null);
  const [why, setWhy] = useState<{ name: string; explanation: PackageExplanation | null } | null>(
    null,
  );
  const [whyErr, setWhyErr] = useState<string | null>(null);
  // Monotonic lookup id: a why? click on package B must not have its result
  // (or spinner) clobbered by package A's slower, earlier response.
  const whySeq = useRef(0);

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

  async function heal(): Promise<void> {
    setConfirmHeal(false);
    setHealBusy(true);
    setHealErr(null);
    setHealResult(null);
    setHealElapsed(0);
    try {
      const result = await runDriftHeal(setHealElapsed);
      setHealResult(result);
      // The job already rescanned server-side; pull the fresh report so the
      // table reflects the post-update state. A refresh failure must NOT go
      // through load() — its loadErr replaces the whole view and would eat
      // the outcome panel; a stale table under a fresh outcome is the
      // lesser evil.
      try {
        setReport(await getDrift());
      } catch {
        // keep the pre-heal table; the outcome panel carries the results
      }
    } catch (err) {
      if (err instanceof Error && (err as ApiError).status === 409) {
        const body = (err as ApiError).body as { lock?: { owner?: string; operation?: string } };
        setHealErr(
          `Another operation is in progress (${body?.lock?.owner ?? '?'}/${body?.lock?.operation ?? '?'}) — wait for it to finish and retry.`,
        );
      } else {
        setHealErr(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setHealBusy(false);
    }
  }

  async function lookupWhy(name: string): Promise<void> {
    const seq = ++whySeq.current;
    setWhyBusy(name);
    setWhyErr(null);
    setWhy(null);
    try {
      const res = await explainDrift([name]);
      if (seq !== whySeq.current) return; // superseded by a newer lookup
      setWhy({ name, explanation: res.explanations.find((e) => e.name === name) ?? null });
    } catch (err) {
      if (seq !== whySeq.current) return;
      setWhyErr(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === whySeq.current) setWhyBusy(null);
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
  const drifting = report.packages.filter((p) => worstClassification(p) !== 'up-to-date');
  const healable = report.packages.filter(isHealable);

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
            Drift between the npm packages the running <code>signalk-server</code> uses and the
            latest versions on the npm registry. Each tracked package can exist in two places, read
            directly from the running container's filesystem: the <strong>Image</strong> copy is
            baked into the <code>signalk-server</code> image and is what the server core loads — it
            only changes when the image is updated. The <strong>User install</strong> copy lives in
            the data dir's plugin tree (<code>~/.signalk/node_modules</code>), put there by npm as a
            dependency of your installed plugins and loaded by those plugins — image updates never
            touch it.
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

      {healErr !== null && (
        <Alert color="danger" className="mb-3" toggle={() => setHealErr(null)}>
          <strong>Could not update plugin dependencies.</strong>
          <div className="small mt-1">{healErr}</div>
        </Alert>
      )}

      {healResult !== null && (
        <HealOutcome result={healResult} onDismiss={() => setHealResult(null)} />
      )}

      {whyErr !== null && (
        <Alert color="danger" className="mb-3" toggle={() => setWhyErr(null)}>
          <strong>Could not look up dependents.</strong>
          <div className="small mt-1">{whyErr}</div>
        </Alert>
      )}

      {why !== null && (
        <Alert color="info" className="mb-3" toggle={() => setWhy(null)}>
          <h6 className="alert-heading mb-2">
            Why is <span className="font-monospace">{why.name}</span> held back?
          </h6>
          {why.explanation === null ? (
            <p className="mb-0 small">
              npm returned no explanation — the package may no longer be installed; rescan to
              refresh the table.
            </p>
          ) : why.explanation.extraneous ? (
            <p className="mb-0 small">
              Nothing depends on it — the copy is extraneous, and npm sweeps extraneous packages on
              the next update run.
            </p>
          ) : why.explanation.dependents.length === 0 ? (
            <p className="mb-0 small">npm reported no direct dependents for this package.</p>
          ) : (
            <p className="mb-0 small">
              Installed <span className="font-monospace">{why.explanation.version ?? '?'}</span>
              <HeldByNote
                dependents={why.explanation.dependents}
                embeddedServer={why.explanation.heldByEmbeddedServer}
              />
            </p>
          )}
        </Alert>
      )}

      <Card>
        <CardHeader className="d-flex justify-content-between align-items-center">
          <strong>Packages</strong>
          <div className="d-flex align-items-center gap-2">
            <span className="text-muted small">
              {drifting.length === 0
                ? `${report.packages.length} tracked, all up to date`
                : `${drifting.length} drifting / ${report.packages.length} tracked`}
            </span>
            <Button
              color="primary"
              outline
              size="sm"
              disabled={healable.length === 0 || healBusy || busy}
              onClick={() => setConfirmHeal(true)}
              title={
                healable.length === 0
                  ? 'No drifting plugin dependencies in the data dir'
                  : `npm update ${healable.length} package${healable.length === 1 ? '' : 's'} in the plugin tree`
              }
            >
              {healBusy && <Spinner size="sm" className="me-2" />}
              {healBusy
                ? `Updating… ${healElapsed}s`
                : `Update plugin dependencies${healable.length > 0 ? ` (${healable.length})` : ''}`}
            </Button>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {report.packages.length === 0 ? (
            <p className="text-muted small p-3 mb-0">
              {report.lastFetchError !== null
                ? 'No package data yet — see the diagnostic alert above for the next step.'
                : 'No tracked packages found. The scan reached the container without error but found none of the tracked packages in either location.'}
            </p>
          ) : (
            <Table responsive size="sm" className="mb-0">
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Image</th>
                  <th>User install</th>
                  <th>Latest</th>
                  <th>Last fetched</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <tr key={p.name}>
                    <td className="font-monospace small">{p.name}</td>
                    <LocationCell location={p.image} />
                    <LocationCell
                      location={p.dataDir}
                      onWhy={isHealable(p) ? () => void lookupWhy(p.name) : undefined}
                      whyBusy={whyBusy === p.name}
                    />
                    <td className="font-monospace small">{p.latest ?? '—'}</td>
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

      <ConfirmModal
        isOpen={confirmHeal}
        title="Update plugin dependencies?"
        body={
          `npm will update ${healable.length} drifting package${healable.length === 1 ? '' : 's'} ` +
          'in the data dir plugin tree (~/.signalk/node_modules) inside the signalk-server ' +
          "container, respecting every plugin's declared version range. The image's copies are " +
          'not touched. Packages whose plugins pin an older range stay put — that residue needs ' +
          'a plugin update, not this button. Afterwards restart signalk-server so plugins reload ' +
          'the updated dependencies.'
        }
        okLabel="Update"
        onConfirm={() => void heal()}
        onCancel={() => setConfirmHeal(false)}
      />
    </div>
  );
}
