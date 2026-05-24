import { Card, CardBody, CardHeader } from 'reactstrap';
import type { ProbeResult } from '../api';
import { StatusPill } from './StatusPill';

interface Props {
  probe: ProbeResult;
}

export function ProbeCard({ probe }: Props) {
  return (
    <Card className="mb-2">
      <CardHeader className="d-flex justify-content-between align-items-center py-2">
        <div className="d-flex align-items-center">
          <StatusPill status={probe.status} />
          <strong>{probe.label}</strong>
        </div>
        <small className="text-muted">{probe.durationMs}ms</small>
      </CardHeader>
      <CardBody className="py-2">
        <p className="mb-2">{probe.message}</p>
        {probe.details && (
          <details>
            <summary className="text-muted small">Details</summary>
            <pre className="mb-0 mt-2 small bg-body-tertiary p-2 rounded">
              {JSON.stringify(probe.details, null, 2)}
            </pre>
          </details>
        )}
      </CardBody>
    </Card>
  );
}
