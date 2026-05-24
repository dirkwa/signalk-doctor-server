# signalk-doctor-server

Peer engine container for the SignalK container stack. Owns **diagnostics and last-known-good recovery**. Runs alongside (not inside) `signalk-server`, independent of `signalk-updater-server`.

## Architecture facts you must keep in mind

- **Not a SignalK plugin.** Standalone Node 24 container started by systemd-user via a Quadlet that the bash installer drops at `~/.config/containers/systemd/signalk-doctor-server.container`.
- **Independent of the updater.** When the updater is broken (bad self-update, crashloop, DBus dead), this is the path back. It must work when nothing else does.
- **Read-only by default.** Probes don't mutate. Only `POST /api/recover` and `POST /api/recover/updater` change anything, and they're gated behind bearer-token auth.
- **Owns Quadlet snapshots.** Writes by the updater (or this container during recovery) live under `~/.signalk-doctor/snapshots/<timestamp>-<filename>` (CC-1). `~/.signalk-doctor/last-good.json` records the validated last-known-good set of tags.
- **Recovery surface is unauthenticated.** Read-only probes do not require a token — they're the way a desperate user discovers what's broken. Only mutating endpoints (`/api/recover*`) require auth.
- **DBus via shelled-out `busctl`.** Inside the container we call `busctl` (from the `systemd` apt package) against `/host/dbus` instead of a JS DBus library. The host bus enforces EXTERNAL UID handshake, and a JS lib running inside a userns'd container can't satisfy that without invasive plumbing; `busctl` already does the right thing.

## Cross-cutting requirements (must hold across every PR)

These are derived from the master plan; do not relax them without updating that plan first.

| ID   | Requirement                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC-1 | Every Quadlet write (by updater OR by this container during recovery) snapshots first. Keep last 10 per file; never prune `last-good`.                                                  |
| CC-2 | Bearer-token auth on mutating routes only. Token at `/data/token` (host `~/.signalk-doctor/token`, mode 0600). Read-only probes are unauthenticated.                                    |
| CC-3 | The host-resident `~/.local/bin/signalk-recovery` script does the same things this container does, via bash. Keep semantics aligned.                                                    |
| CC-4 | Quadlets use `Restart=on-failure` + `StartLimitIntervalSec=300` + `StartLimitBurst=5`. `Restart=always` is banned.                                                                      |
| CC-5 | Single-writer mutex via `~/.signalk-updater/operation.lock` shared with the updater. Refuse to recover while the updater holds the lock; surface a clear "wait or force-clear" message. |
| CC-6 | Categorized errors at the dockerode wrapper boundary.                                                                                                                                   |

## Workflow Conventions

This repo is maintained by Dirk Wahrheit. Workflow is deliberate; AI tools should follow it strictly.

### Branch and commit rules

- Branch names use **hyphens**, never slashes.
- Angular conventional commits: `<type>(<scope>): <subject>`. Subject ≤ 50 chars, imperative, no period.
- One logical change per commit.
- No `Co-Authored-By` lines. No "Generated with Claude Code" attribution.

### PR rules

- Never commit directly to `master`. Every change goes through a PR.
- One logical change per PR.
- PR titles describe what changes; PR bodies explain _why_.
- No checkboxes in PR descriptions.
- Version bumps live in their own `chore(release): X.Y.Z` PR.

### Pre-PR checklist

```bash
npm run format
npm run build:all
npm run ci-lint
cr review --plain | tee cr-review-<branch>.txt
```

Save the cr output to a repo-local file (the repo `.gitignore`s `cr-review*.txt`); `cr` is rate-limited so reruns are expensive. Skip `cr review` only for `chore(release): X.Y.Z` PRs.

### Release flow

Tag `vX.Y.Z` triggers `.github/workflows/publish.yml` which builds a multi-arch image and pushes to `ghcr.io/dirkwa/signalk-doctor-server:X.Y.Z` plus moving tags (`:X.Y`, `:X`, `:latest` for stable, `:beta` for prereleases). Never publish without explicit approval.

## TypeScript

- `"type": "module"`, ESM throughout. Relative imports use `.js` suffix (NodeNext resolution).
- `tsconfig.json` runs with the full strict-TS set: `strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noImplicitOverride`. Code must narrow against `undefined` when reading array slots or record entries.
- `tsconfig.webapp.json` mirrors the same flag set for the React webapp.

## File layout

| Path                                                                                                                  | Purpose                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                                                        | Entrypoint. Starts Fastify on `PORT` / `HOST`.                                                                               |
| `src/server.ts`                                                                                                       | Fastify factory; registers route modules and the static webapp.                                                              |
| `src/auth.ts`                                                                                                         | Bearer-token middleware (CC-2).                                                                                              |
| `src/errors.ts`                                                                                                       | Error categorization (CC-6).                                                                                                 |
| `src/types.ts`                                                                                                        | Cross-cutting TypeScript contracts.                                                                                          |
| `src/log-stream-broker.ts`                                                                                            | Single-process ring buffer + fan-out for container log SSE.                                                                  |
| `src/mutex.ts`                                                                                                        | In-process wrapper around `~/.signalk-updater/operation.lock` (CC-5).                                                        |
| `src/podman/client.ts`                                                                                                | dockerode wrapper + runtime (podman/docker) detection. All container calls go here.                                          |
| `src/probes/runner.ts`                                                                                                | Probe orchestration; returns `{ ranAt, durationMs, results, summary }`.                                                      |
| `src/probes/{containers,dbus,disk,memory,podman,signalk-health,snapshots,time-drift,updater-health,version-drift}.ts` | Individual probes.                                                                                                           |
| `src/quadlet/rewriter.ts`                                                                                             | Atomic Quadlet writes + snapshot bookkeeping (CC-1).                                                                         |
| `src/recovery/restore.ts`                                                                                             | Last-known-good restore (CC-3 — twin of the host bash script).                                                               |
| `src/dbus/systemd-user.ts`                                                                                            | `busctl` shell-out for `systemctl --user daemon-reload` / `restart`.                                                         |
| `src/routes/health.ts`                                                                                                | `GET /api/health`.                                                                                                           |
| `src/routes/session.ts`                                                                                               | `GET /api/session` (returns the bearer token from `/data/token`).                                                            |
| `src/routes/probes.ts`                                                                                                | `GET /api/probes`.                                                                                                           |
| `src/routes/recover.ts`                                                                                               | `GET /api/snapshots`, `GET /api/last-good`, `POST /api/recover{,/updater}`.                                                  |
| `src/routes/logs-stream.ts`                                                                                           | `GET /api/containers/:name/logs/stream` (SSE) + `/logs` (snapshot).                                                          |
| `webapp/`                                                                                                             | Browser UI (React + reactstrap, bundled Bootstrap 5, dual color modes).                                                      |
| `webapp/src/App.tsx`                                                                                                  | Hash-routed tab shell. Views: Health / Logs / Snapshots / Recovery.                                                          |
| `webapp/src/api.ts`                                                                                                   | Typed API client. Bearer attached on non-GET only (CC-2).                                                                    |
| `webapp/src/useLogStream.ts`                                                                                          | EventSource hook with pause/resume + visibility-suspend.                                                                     |
| `vite.config.ts`                                                                                                      | Builds `webapp/` → `webapp-dist/`. Dev proxy SSE-friendly.                                                                   |
| `tsconfig.json`                                                                                                       | Server TS → `dist/`.                                                                                                         |
| `tsconfig.webapp.json`                                                                                                | Webapp TS typecheck only (Vite handles emit).                                                                                |
| `Dockerfile`                                                                                                          | Multi-stage Node 24 on Debian 13 (trixie-slim). Runtime needs `busctl` from the systemd apt package, so we're not on Alpine. |
| `.github/workflows/ci.yml`                                                                                            | PR lint + build + test.                                                                                                      |
| `.github/workflows/publish.yml`                                                                                       | Tag-triggered multi-arch buildx → GHCR.                                                                                      |

## Container mounts (final shape)

| Host path                           | Container path         | Mode | Purpose                                         |
| ----------------------------------- | ---------------------- | ---- | ----------------------------------------------- |
| `/run/user/$UID/podman/podman.sock` | `/var/run/docker.sock` | rw   | dockerode talks to the rootless podman socket.  |
| `~/.signalk-doctor`                 | `/data`                | rw   | Token, snapshots, last-known-good state.        |
| `~/.config/containers/systemd`      | `/quadlets`            | rw   | Quadlet reads + atomic writes (CC-1 snapshots). |
| `/run/user/$UID/bus`                | `/host/dbus`           | ro   | `busctl --user` against the host session bus.   |
| `~/.signalk-updater`                | `/updater-data`        | ro   | Shared `operation.lock` only (CC-5).            |

## Webapp

- **React + reactstrap**, Bootstrap 5 bundled directly (no admin-CSS injection — this container is standalone on port 3004, not embedded inside signalk-server). The bundled approach intentionally diverges from the [signalk-backup](https://github.com/dirkwa/signalk-backup) pattern, which DOES inject the admin's stylesheet manifest because it runs at `/signalk-backup/` inside the SignalK server.
- **Dual color modes** via `data-bs-theme` driven by `matchMedia('(prefers-color-scheme: dark)')` in `webapp/src/theme.ts`. No in-UI toggle.
- **Same-origin API calls** at `/api/*`. The Fastify host serves both the API and the static bundle from `webapp-dist/`. Dev mode runs Vite on `:5173` and proxies `/api` to a real doctor-server on `:3004`.
- **Bearer attached on non-GET** in `webapp/src/api.ts`. Read-only GETs stay unauthenticated per CC-2.
- **Feature parity, not feature creep**: a webapp PR that grows beyond Health/Logs/Snapshots/Recovery should justify the new surface in the description (probably a separate PR).

## Relationship to signalk-updater-server

This container is a deliberate code-twin of [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server) at the skeleton level: same Fastify factory, same `src/podman/client.ts` shape, same `src/errors.ts`, same Dockerfile pattern. They diverge once each has its real feature set:

- **Updater = mutating.** Writes Quadlets, calls `podman pull`, calls `systemctl --user restart`.
- **Doctor = read-mostly.** Reads Quadlets and journal, runs probes. Mutation is limited to recovery (restore snapshot + daemon-reload + restart) and is gated.

Lifting code between the two repos is fine and expected. When a helper proves useful in both, copy with attribution rather than introducing a monorepo. The two repos do NOT share the same web framework conventions: the updater uses TypeBox-validated routes, the doctor doesn't (its routes are simpler and the read-only ones don't need body validation; mutating ones are bare POSTs).
