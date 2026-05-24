import { Alert, Card, CardBody, CardHeader, Spinner, Table } from 'reactstrap';
import {
  getLastGood,
  getSnapshots,
  fmtTime,
  fmtSize,
  relTime,
  type LastGoodResponse,
  type SnapshotEntry,
  type SnapshotsResponse,
} from '../api';
import { useApi } from '../useApi';

interface GroupedSnapshots {
  group: string;
  snaps: SnapshotEntry[];
}

// Snapshot files are named `<mangled-iso>-<quadlet>` by snapshotQuadlet()
// in src/quadlet/rewriter.ts — the ISO timestamp has `:` and `.` replaced
// by `-`, e.g. `2026-05-24T15-30-00-123Z-signalk-updater-server.container`.
// Strip the timestamp prefix so files for the same quadlet group together;
// a naive `/-(.*)$/` would match the last dash and lump unrelated
// quadlets (e.g. signalk-server.container and signalk-updater-server.container)
// under the same bucket.
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z?-/;

function groupByQuadlet(resp: SnapshotsResponse): GroupedSnapshots[] {
  const grouped = new Map<string, SnapshotEntry[]>();
  for (const snap of resp.snapshots) {
    const group = snap.name.replace(TIMESTAMP_PREFIX, '') || snap.name;
    const bucket = grouped.get(group);
    if (bucket) bucket.push(snap);
    else grouped.set(group, [snap]);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, snaps]) => ({ group, snaps }));
}

function LastGoodBlock({ data }: { data: LastGoodResponse | null }) {
  if (!data || Object.keys(data.quadlets).length === 0) {
    return (
      <Card className="mb-3">
        <CardHeader>
          <strong>Last-known-good</strong>
        </CardHeader>
        <CardBody>
          <p className="text-muted mb-0">
            No last-known-good entries yet — the first successful version switch records one.
          </p>
        </CardBody>
      </Card>
    );
  }
  const updated = data.updatedAt
    ? `Updated ${fmtTime(data.updatedAt)} (${relTime(data.updatedAt)})`
    : 'Updated time unknown';
  return (
    <Card className="mb-3">
      <CardHeader>
        <strong>Last-known-good</strong> <span className="text-muted small ms-2">{updated}</span>
      </CardHeader>
      <CardBody className="p-0">
        <Table size="sm" className="mb-0">
          <thead>
            <tr>
              <th>Quadlet</th>
              <th>Tag</th>
              <th>Snapshot file</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.quadlets).map(([quadlet, entry]) => (
              <tr key={quadlet}>
                <td>{quadlet}</td>
                <td className="font-monospace">{entry.tag ?? '—'}</td>
                <td className="font-monospace small">
                  {entry.snapshotPath ?? entry.snapshotFile ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </CardBody>
    </Card>
  );
}

function SnapshotGroup({ group, snaps }: GroupedSnapshots) {
  return (
    <Card className="mb-3">
      <CardHeader>
        <strong>{group}</strong>{' '}
        <span className="text-muted small ms-2">
          {snaps.length} snapshot{snaps.length === 1 ? '' : 's'}
        </span>
      </CardHeader>
      <CardBody className="p-0">
        <Table size="sm" className="mb-0">
          <thead>
            <tr>
              <th>File</th>
              <th>Captured</th>
              <th></th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {snaps.map((snap) => (
              <tr key={snap.path}>
                <td className="font-monospace small">{snap.name}</td>
                <td>{fmtTime(snap.mtime)}</td>
                <td className="text-muted small">{relTime(snap.mtime)}</td>
                <td>{fmtSize(snap.size)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </CardBody>
    </Card>
  );
}

export function Snapshots() {
  const snapshotsApi = useApi(getSnapshots);
  const lastGoodApi = useApi(getLastGood);

  const loading = snapshotsApi.loading || lastGoodApi.loading;
  const error = snapshotsApi.error ?? lastGoodApi.error;
  const groups = snapshotsApi.data ? groupByQuadlet(snapshotsApi.data) : [];

  return (
    <div>
      {snapshotsApi.data && (
        <p className="text-muted small mb-3">
          {snapshotsApi.data.count > 0
            ? `${snapshotsApi.data.count} Quadlet snapshot${snapshotsApi.data.count === 1 ? '' : 's'} on disk`
            : 'No Quadlet snapshots yet — none have been written by the updater or doctor.'}
        </p>
      )}

      {error && <Alert color="danger">Failed to load snapshots: {error}</Alert>}

      {loading && !snapshotsApi.data && (
        <div className="text-center my-4">
          <Spinner /> <span className="ms-2 text-muted">Loading snapshots…</span>
        </div>
      )}

      <LastGoodBlock data={lastGoodApi.data} />

      {groups.map((g) => (
        <SnapshotGroup key={g.group} group={g.group} snaps={g.snaps} />
      ))}
    </div>
  );
}
