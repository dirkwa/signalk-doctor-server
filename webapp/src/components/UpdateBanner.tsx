import { Alert } from 'reactstrap';
import { getCheckUpdate } from '../api';
import { useApi } from '../useApi';

interface Props {
  /** Where to send the user for the actual self-update flow. */
  updaterUrl: string;
}

/**
 * Shows a Bootstrap "info" alert when GHCR has a newer stable tag than
 * the engine's running version. The Doctor never self-updates from its
 * own UI by design (it's the read-mostly recovery surface); the banner
 * just points the user at the Updater Console. Stays silent when the
 * GHCR check fails, when there's no update, or while the engine reports
 * version "unknown" (e.g. dev builds).
 */
export function UpdateBanner({ updaterUrl }: Props) {
  const { data } = useApi(getCheckUpdate, { intervalMs: 6 * 60 * 60 * 1000 });

  if (!data || !data.updateAvailable || data.latest === undefined) return null;

  return (
    <Alert color="info" className="mb-3 d-flex align-items-center justify-content-between">
      <div>
        <strong>SignalK Doctor {data.latest} is available.</strong>
        <span className="text-muted ms-2">Running {data.current}.</span>
      </div>
      <a
        href={updaterUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-sm btn-primary"
      >
        Open Updater Console ↗
      </a>
    </Alert>
  );
}
