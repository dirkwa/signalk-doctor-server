import { Alert } from 'reactstrap';
import { getCheckUpdate } from '../api';
import { useApi } from '../useApi';

/**
 * Shows a Bootstrap "info" alert when GHCR has a newer stable tag than
 * the engine's running version. The Doctor never self-updates from its
 * own UI by design (it's the read-mostly recovery surface); the banner
 * is purely informational. The actual self-update flow lives in the
 * Updater Console (reachable from the SignalK admin sidebar in
 * embedded mode). Stays silent when the GHCR check fails, when there's
 * no update, or while the engine reports version "unknown" (e.g. dev
 * builds).
 */
export function UpdateBanner() {
  const { data } = useApi(getCheckUpdate, { intervalMs: 6 * 60 * 60 * 1000 });

  if (!data || !data.updateAvailable || data.latest === undefined) return null;

  return (
    <Alert color="info" className="mb-3">
      <strong>SignalK Doctor {data.latest} is available.</strong>
      <span className="text-muted ms-2">Running {data.current}.</span>
    </Alert>
  );
}
