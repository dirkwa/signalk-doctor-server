import { Badge } from 'reactstrap';
import type { ProbeStatus } from '../api';

const COLOR_MAP: Record<ProbeStatus, string> = {
  ok: 'success',
  warn: 'warning',
  fail: 'danger',
  unknown: 'secondary',
};

interface Props {
  status: ProbeStatus;
  count?: number;
  label?: string;
}

export function StatusPill({ status, count, label }: Props) {
  const text = label ?? status;
  return (
    <Badge color={COLOR_MAP[status]} pill className="me-2">
      {count !== undefined ? `${count} ${text}` : text}
    </Badge>
  );
}
