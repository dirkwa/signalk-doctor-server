import { useEffect, useMemo, useState } from 'react';
import { Container, Nav, NavItem, NavLink } from 'reactstrap';
import { getHealth } from './api';
import { Health } from './views/Health';
import { Logs } from './views/Logs';
import { Snapshots } from './views/Snapshots';
import { Recover } from './views/Recover';
import { UpdateBanner } from './components/UpdateBanner';

type Route = 'health' | 'logs' | 'snapshots' | 'recover';

const ROUTES: { id: Route; label: string }[] = [
  { id: 'health', label: 'Health' },
  { id: 'logs', label: 'Logs' },
  { id: 'snapshots', label: 'Snapshots' },
  { id: 'recover', label: 'Recovery' },
];

function parseHash(hash: string): Route {
  const trimmed = hash.replace(/^#\/?/, '');
  return ROUTES.some((r) => r.id === trimmed) ? (trimmed as Route) : 'health';
}

function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  const navigate = (r: Route): void => {
    window.location.hash = `#/${r}`;
  };
  return [route, navigate];
}

export function App() {
  const [route, navigate] = useHashRoute();
  const [brandVersion, setBrandVersion] = useState<string>('—');

  useEffect(() => {
    getHealth()
      .then((h) => {
        setBrandVersion(h.version && h.version !== 'unknown' ? `v${h.version}` : '—');
      })
      .catch(() => {
        setBrandVersion('—');
      });
  }, []);

  // Updater Console runs as its own peer container on port 3003.
  // Mirror the host/protocol the user reached us on so links work
  // behind reverse proxies and arbitrary hostnames.
  const updaterUrl = useMemo(() => {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:3003/`;
  }, []);

  return (
    <Container className="py-4">
      <div className="d-flex align-items-center mb-4">
        <img src="/app-icon.svg" alt="" width={40} height={40} className="me-3" />
        <h1 className="mb-0">SignalK Doctor</h1>
        <span
          className="text-muted ms-3 align-self-end mb-2 font-monospace small"
          title="Engine container version"
        >
          {brandVersion}
        </span>
        <span className="ms-auto text-muted small font-monospace">v{__APP_VERSION__}</span>
      </div>

      <UpdateBanner updaterUrl={updaterUrl} />

      <Nav tabs className="mb-3 align-items-end">
        {ROUTES.map((r) => (
          <NavItem key={r.id}>
            <NavLink
              href={`#/${r.id}`}
              active={route === r.id}
              onClick={(e) => {
                e.preventDefault();
                navigate(r.id);
              }}
            >
              {r.label}
            </NavLink>
          </NavItem>
        ))}
        <NavItem className="ms-auto">
          <NavLink href={updaterUrl} target="_blank" rel="noopener noreferrer">
            Open Updater Console ↗
          </NavLink>
        </NavItem>
      </Nav>

      {route === 'health' && <Health />}
      {route === 'logs' && <Logs />}
      {route === 'snapshots' && <Snapshots />}
      {route === 'recover' && <Recover />}
    </Container>
  );
}
