import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Form, FormGroup, Input, Label } from 'reactstrap';
import { useLogStream, type LogStatus, type ParsedLogLine } from '../useLogStream';

const CONTAINERS = ['signalk-doctor-server', 'signalk-updater-server', 'signalk-server'] as const;

const STATUS_COLOR: Record<LogStatus, string> = {
  connecting: 'info',
  connected: 'success',
  paused: 'warning',
  error: 'danger',
  disconnected: 'secondary',
};

function fmtLogTime(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso.slice(11, 19);
  }
}

function levelTextClass(level: string): string {
  if (level === 'error' || level === 'fatal') return 'text-danger';
  if (level === 'warn') return 'text-warning';
  if (level === 'debug' || level === 'trace') return 'text-info';
  if (level === 'info') return 'text-body';
  return 'text-muted';
}

interface RowProps {
  line: ParsedLogLine;
}

function LogRow({ line }: RowProps) {
  return (
    <div className={`d-flex font-monospace small ${levelTextClass(line.level)}`}>
      <span className="text-muted me-2" style={{ minWidth: '4.5rem' }}>
        {fmtLogTime(line.time)}
      </span>
      <span className="text-uppercase me-2" style={{ minWidth: '3.5rem' }}>
        {line.level}
      </span>
      <span className="text-break flex-grow-1">{line.message}</span>
    </div>
  );
}

export function Logs() {
  const [containerName, setContainerName] = useState<string>(CONTAINERS[0]);
  const [tail, setTail] = useState<number>(500);
  const { lines, status, paused, togglePause, clear } = useLogStream({
    containerName,
    tail,
    enabled: true,
  });

  // Auto-scroll to bottom when new lines arrive, unless the user has
  // scrolled away — same UX as the vanilla console.
  const outputRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = outputRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const handleScroll = (): void => {
    const el = outputRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  };

  return (
    <div>
      <Form className="d-flex flex-wrap align-items-end gap-3 mb-3">
        <FormGroup className="mb-0">
          <Label for="logs-container" className="form-label small mb-1">
            Container
          </Label>
          <Input
            id="logs-container"
            type="select"
            bsSize="sm"
            value={containerName}
            onChange={(e) => {
              setContainerName(e.target.value);
            }}
          >
            {CONTAINERS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Input>
        </FormGroup>
        <FormGroup className="mb-0">
          <Label for="logs-lines" className="form-label small mb-1">
            Lines
          </Label>
          <Input
            id="logs-lines"
            type="number"
            bsSize="sm"
            min={50}
            max={5000}
            value={tail}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n)) setTail(n);
            }}
            style={{ width: '6rem' }}
          />
        </FormGroup>
        <div className="d-flex align-items-center gap-2">
          <Badge color={STATUS_COLOR[status]} pill>
            {status}
          </Badge>
          <Button size="sm" color="secondary" outline onClick={togglePause}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" color="secondary" outline onClick={clear}>
            Clear
          </Button>
        </div>
      </Form>

      <div
        ref={outputRef}
        onScroll={handleScroll}
        className="bg-body-tertiary border rounded p-2"
        style={{ height: '60vh', overflowY: 'auto' }}
      >
        {lines.length === 0 ? (
          <div className="text-muted">Connecting…</div>
        ) : (
          lines.map((line) => <LogRow key={line.id} line={line} />)
        )}
      </div>
    </div>
  );
}
