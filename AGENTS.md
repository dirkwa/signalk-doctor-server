# signalk-doctor-server

Peer engine container for the SignalK container stack. Owns **diagnostics, last-known-good recovery, and targeted remediation** (plugin-dependency heal). Runs alongside (not inside) `signalk-server`, independent of `signalk-updater-server`.

## Architecture facts you must keep in mind

- **Not a SignalK plugin.** Standalone Node 24 container started by systemd-user via a Quadlet that the bash installer drops at `~/.config/containers/systemd/signalk-doctor-server.container`.
- **Independent of the updater.** When the updater is broken (bad self-update, crashloop, DBus dead), this is the path back. It must work when nothing else does.
- **Read-mostly by design.** Probes don't mutate. The full mutating surface — every route bearer-gated per CC-2 — is `POST /api/recover{,/updater}` (snapshot restore), `POST /api/installer/refresh` (host script/Quadlet-template rewrite), `POST /api/bug-report` (spawns the host collector), `POST /api/drift/refresh` (rescan; only rewrites the doctor's own `/data/drift.json`), and `POST /api/drift/heal` (range-respecting `npm update` of drifting plugin-tree dependencies inside signalk-server, via the container exec API). Recover, installer-refresh and drift-heal serialize on the shared operation lock (CC-5); drift-heal deliberately keeps holding it when npm cannot be proven stopped.
- **Owns Quadlet snapshots.** Writes by the updater (or this container during recovery) live under `~/.signalk-doctor/snapshots/<timestamp>-<filename>` (CC-1). `~/.signalk-doctor/last-good.json` records the validated last-known-good set of tags.
- **Read-only surface is unauthenticated.** Probes and other read-only views do not require a token — they're the way a desperate user discovers what's broken. Only the mutating endpoints listed above require auth; async-job status GETs (`/api/bug-report/:jobId`, `/api/drift/heal/:jobId`) stay tokenless, the random jobId being the capability. The deliberate exception is `GET /api/session`, which returns the bearer token itself: reaching the engine's published port at all (127.0.0.1 by default; LAN only when installed with `SIGNALK_LAN_EXPOSE=true`) is the trust boundary, and the token's job is blocking cross-origin browser-initiated mutations — a hostile page can fire requests at the port but can never read the session response. Rationale lives in `src/routes/session.ts`.
- **DBus via shelled-out `busctl`.** Inside the container we call `busctl` (from the `systemd` apt package) against `/host/dbus` instead of a JS DBus library. The host bus enforces EXTERNAL UID handshake, and a JS lib running inside a userns'd container can't satisfy that without invasive plumbing; `busctl` already does the right thing.
- **SignalK health probe is SSL-aware by observing runtime, not config.** The probe distinguishes a plain-HTTP signalk-server from a TLS-enabled one by what the HTTP endpoint returns (a direct response vs a redirect to HTTPS), and follows to HTTPS when redirected — rather than reading `ssl`/`sslport` out of `~/.signalk` (which the doctor deliberately does not mount). This self-heals when the operator toggles SSL. The exact status handling, the TLS-relaxed HTTPS hop, and the `SIGNALK_URL`/`SIGNALK_HTTPS_URL` env wiring (templated into our Quadlet by the installer) live in `src/probes/signalk-health.ts` + `src/probes/signalk-url.ts` and their tests — the authoritative source; implementation specifics are intentionally kept out of this bullet to avoid drift.

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
cr review --base master > cr-review-<branch>.txt; echo "exit=$?"
```

Save the cr output to a repo-local file (the repo `.gitignore`s `cr-review*.txt`); `cr` is rate-limited so reruns are expensive. Skip `cr review` only for `chore(release): X.Y.Z` PRs.

Two things about that command are deliberate:

- **No `--plain`.** It was removed in `cr` 0.7.x — plain text is now the default and the flag is a hard error. It was also piped through `tee`, which reports its own exit status, so the old form wrote a usage dump into the review file and reported success. Redirect and check the code instead of piping, so a review that never ran cannot look like a clean one.
- **`--base master` is explicit.** Without it `cr` reviews working-tree changes, which on a committed branch is nothing at all — the same clean-looking no-op by a different route.

Confirm the file holds actual findings before treating the review as done. A zero exit is not evidence a review happened.

### Release flow

Tag `vX.Y.Z` triggers `.github/workflows/publish.yml` which builds a multi-arch image and pushes to `ghcr.io/dirkwa/signalk-doctor-server:X.Y.Z` plus moving tags (`:X.Y`, `:X`, `:latest` for stable, `:beta` for prereleases). Never publish without explicit approval.

## TypeScript

- `"type": "module"`, ESM throughout. Relative imports use `.js` suffix (NodeNext resolution).
- `tsconfig.json` runs with the full strict-TS set: `strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noImplicitOverride`. Code must narrow against `undefined` when reading array slots or record entries.
- `tsconfig.webapp.json` mirrors the same flag set for the React webapp.

## File layout

| Path                                                                                                                                                                  | Purpose                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                                                                                                        | Entrypoint. Starts Fastify on `PORT` / `HOST`.                                                                                                                                                                                                                         |
| `src/server.ts`                                                                                                                                                       | Fastify factory; registers route modules and the static webapp.                                                                                                                                                                                                        |
| `src/auth.ts`                                                                                                                                                         | Bearer-token middleware (CC-2).                                                                                                                                                                                                                                        |
| `src/errors.ts`                                                                                                                                                       | Error categorization (CC-6).                                                                                                                                                                                                                                           |
| `src/types.ts`                                                                                                                                                        | Cross-cutting TypeScript contracts.                                                                                                                                                                                                                                    |
| `src/log-stream-broker.ts`                                                                                                                                            | Single-process ring buffer + fan-out for container log SSE.                                                                                                                                                                                                            |
| `src/mutex.ts`                                                                                                                                                        | In-process wrapper around `~/.signalk-updater/operation.lock` (CC-5).                                                                                                                                                                                                  |
| `src/podman/client.ts`                                                                                                                                                | dockerode wrapper + runtime (podman/docker) detection. All container calls go here.                                                                                                                                                                                    |
| `src/probes/runner.ts`                                                                                                                                                | Probe orchestration; returns `{ ranAt, durationMs, results, summary }`.                                                                                                                                                                                                |
| `src/probes/{cgroup-delegation,containers,dbus,dependency-drift,disk,memory,podman,signalk-health,snapshots,storage-type,time-drift,updater-health,version-drift}.ts` | Individual probes. `dependency-drift` surfaces the persisted drift report's verdict (warn on major only, judged per location).                                                                                                                                         |
| `src/probes/signalk-url.ts`                                                                                                                                           | Resolves the signalk-server HTTP / HTTPS endpoints (env, call-time). See "SignalK health probe is SSL-aware" below.                                                                                                                                                    |
| `src/quadlet/rewriter.ts`                                                                                                                                             | Atomic Quadlet writes + snapshot bookkeeping (CC-1).                                                                                                                                                                                                                   |
| `src/recovery/restore.ts`                                                                                                                                             | Last-known-good restore (CC-3 — twin of the host bash script).                                                                                                                                                                                                         |
| `src/dbus/systemd-user.ts`                                                                                                                                            | `busctl` shell-out for `systemctl --user daemon-reload` / `restart`.                                                                                                                                                                                                   |
| `src/routes/health.ts`                                                                                                                                                | `GET /api/health`.                                                                                                                                                                                                                                                     |
| `src/routes/session.ts`                                                                                                                                               | `GET /api/session` (returns the bearer token from `/data/token`).                                                                                                                                                                                                      |
| `src/routes/probes.ts`                                                                                                                                                | `GET /api/probes`.                                                                                                                                                                                                                                                     |
| `src/routes/recover.ts`                                                                                                                                               | `GET /api/snapshots`, `GET /api/last-good`, `POST /api/recover{,/updater}`.                                                                                                                                                                                            |
| `src/routes/self.ts`                                                                                                                                                  | `GET /api/self/check-update` (read-only GHCR check; the doctor never self-updates).                                                                                                                                                                                    |
| `src/routes/installer.ts`, `src/installer/refresh.ts`                                                                                                                 | `GET /api/installer/status`, `POST /api/installer/refresh` — fetch the bash installer payload from GitHub Pages and rewrite host scripts + Quadlet templates. Snapshot-first per CC-1.                                                                                 |
| `src/ghcr.ts`, `src/tagClassifier.ts`                                                                                                                                 | GHCR registry client + tag channel classifier. Copy of the same files in signalk-updater-server.                                                                                                                                                                       |
| `src/routes/logs-stream.ts`                                                                                                                                           | `GET /api/containers/:name/logs/stream` (SSE) + `/logs` (snapshot).                                                                                                                                                                                                    |
| `src/routes/drift.ts`                                                                                                                                                 | `GET /api/drift`, `POST /api/drift/refresh`, `POST /api/drift/heal` + `GET /api/drift/heal/:jobId` (async heal job, 202 + poll).                                                                                                                                       |
| `src/drift/{scanner,scheduler,store,classify,npm-registry,installed-packages,types}.ts`                                                                               | Pinned-dependency drift: scheduled scanner reads tracked package versions from the running signalk-server's filesystem — image tree and data-dir plugin tree reported separately — compares against npm (ETag-cached, offline-resilient), persists `/data/drift.json`. |
| `src/drift/{heal,heal-jobs}.ts`                                                                                                                                       | Data-dir heal: range-respecting `npm update` of drifting plugin-tree copies (never `@latest`), per-package updated/range-limited/unchanged outcomes, `lockRetained` when npm can't be proven stopped; in-memory async job registry.                                    |
| `src/podman/exec.ts`                                                                                                                                                  | Container exec wrapper: argv-only (no shell), tail-bounded combined output, timeout + linger grace, `stillRunning` whenever a stop cannot be proven (CC-6 categorized errors).                                                                                         |
| `src/bug-report.ts`, `src/bug-report-jobs.ts`, `src/routes/bug-report.ts`                                                                                             | Host `signalk bug-report` shell-out + async job registry; `POST /api/bug-report`, `GET /api/bug-report/:jobId{,/download}`.                                                                                                                                            |
| `src/image-retention.ts`                                                                                                                                              | Boot-time retention for the doctor's own superseded `:<semver>` image tags (nothing else reclaims them; ~290 MB each).                                                                                                                                                 |
| `webapp/`                                                                                                                                                             | Browser UI (React + reactstrap, bundled Bootstrap 5, dual color modes).                                                                                                                                                                                                |
| `webapp/src/App.tsx`                                                                                                                                                  | Hash-routed tab shell. Views: Health / Logs / Snapshots / Drift / Recovery / Bug report / Installer.                                                                                                                                                                   |
| `webapp/src/api.ts`                                                                                                                                                   | Typed API client. Bearer attached on non-GET only (CC-2).                                                                                                                                                                                                              |
| `webapp/src/useLogStream.ts`                                                                                                                                          | EventSource hook with pause/resume + visibility-suspend.                                                                                                                                                                                                               |
| `vite.config.ts`                                                                                                                                                      | Builds `webapp/` → `webapp-dist/`. Dev proxy SSE-friendly.                                                                                                                                                                                                             |
| `tsconfig.json`                                                                                                                                                       | Server TS → `dist/`.                                                                                                                                                                                                                                                   |
| `tsconfig.webapp.json`                                                                                                                                                | Webapp TS typecheck only (Vite handles emit).                                                                                                                                                                                                                          |
| `Dockerfile`                                                                                                                                                          | Multi-stage Node 24 on Debian 13 (trixie-slim). Runtime needs `busctl` from the systemd apt package, so we're not on Alpine.                                                                                                                                           |
| `.github/workflows/ci.yml`                                                                                                                                            | PR lint + build + test.                                                                                                                                                                                                                                                |
| `.github/workflows/publish.yml`                                                                                                                                       | Tag-triggered multi-arch buildx → GHCR.                                                                                                                                                                                                                                |

## Container mounts (final shape)

| Host path                           | Container path         | Mode | Purpose                                                                                                                                                                       |
| ----------------------------------- | ---------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/run/user/$UID/podman/podman.sock` | `/var/run/docker.sock` | rw   | dockerode talks to the rootless podman socket.                                                                                                                                |
| `~/.signalk-doctor`                 | `/data`                | rw   | Token, snapshots, last-known-good state.                                                                                                                                      |
| `~/.config/containers/systemd`      | `/quadlets`            | rw   | Quadlet reads + atomic writes (CC-1 snapshots).                                                                                                                               |
| `/run/user/$UID/bus`                | `/host/dbus`           | ro   | `busctl --user` against the host session bus.                                                                                                                                 |
| `~/.signalk-updater`                | `/updater-data`        | ro   | Shared `operation.lock` only (CC-5).                                                                                                                                          |
| `~/.local/bin`                      | `/host-bin`            | rw   | `~/.local/bin/signalk` + `signalk-recovery` rewrites for the installer-refresh endpoint. Absent on older installs — the endpoint reports `mount-missing` rather than failing. |

## Self-update flow

The doctor is **read-mostly by design** and never updates itself from its own UI. The relevant pieces:

- **`GET /api/self/check-update`** in `src/routes/self.ts` queries GHCR for the latest stable tag of `ghcr.io/dirkwa/signalk-doctor-server`, compares to the engine's running version (loaded from the container's own `package.json` at boot, same pattern as `health.ts`), and returns `{ current, latest, updateAvailable, cachedAt, updateVia: "signalk-updater-server" }`. Unauthenticated per CC-2 (it's read-only and just hits a public registry).
- **No `POST /api/self/update` route here.** The actual pull + Quadlet rewrite + restart is [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server)'s job — the endpoint design lives in the [engine-updates plan](https://github.com/dirkwa/signalk-universal-installer/blob/main/plans/engine-updates.md). By policy the doctor never rewrites its OWN Quadlet: although `/quadlets` is mounted rw, the doctor's Quadlet writes are limited to recovery restores and installer-refresh template updates — both snapshot-first (CC-1) and serialized on the shared lock (CC-5) — while moving the doctor itself to a new image is the updater's job.
- **`webapp/src/components/UpdateBanner.tsx`** renders a small "newer version available" alert on top of every view when `updateAvailable === true`, with a button to the Updater Console. The Doctor Console never offers a self-update button.
- **GHCR helpers (`src/ghcr.ts`, `src/tagClassifier.ts`)** are deliberately a copy of the same files in signalk-updater-server. They classify image tags into stable/beta/master/dirkwa channels and pick the highest semver via `compareSemver`. Same problem, same solution — keep them aligned.

The installer-refresh endpoint (`POST /api/installer/refresh`) is **not** a self-update — it rewrites the host-side bash scripts (`~/.local/bin/signalk`, `signalk-recovery`) and refreshes Quadlet templates from GitHub Pages. The doctor's own container image is never touched. Operators reach for it when `signalk help` is stale relative to the installer published to Pages; the bash `curl … | bash` one-liner remains the floor when the doctor itself is broken.

## Webapp

- **React + reactstrap**, Bootstrap 5 bundled directly. The same bundle serves two surfaces (see "Two deployments, one bundle" below): standalone at `:3004`, and iframed by the [signalk-doctor](https://github.com/dirkwa/signalk-doctor) plugin into the SignalK admin sidebar.
- **Dual color modes** via `data-bs-theme` driven by `matchMedia('(prefers-color-scheme: dark)')` in `webapp/src/theme.ts`. No in-UI toggle.
- **API base via `<meta name="api-base">`.** `webapp/src/api.ts` is the single source of truth for the API base — it reads the meta tag at module load and exposes the resolved base for every network call. **All `fetch()` and `new EventSource()` must go through `api.ts`** (directly or via helpers like `logsStreamUrl`); a network call that hand-rolls a `/api/...` URL elsewhere will skip the prefix and break under the proxy. Standalone has no meta tag, so the base stays empty and paths remain `/api/*` exactly as before.
- **Bearer attached on non-GET** in `webapp/src/api.ts`. Read-only GETs stay unauthenticated per CC-2.
- **Feature parity, not feature creep**: a webapp PR that grows beyond the existing views (Health/Logs/Snapshots/Drift/Recovery/Bug report/Installer) should justify the new surface in the description (probably a separate PR).

## Two deployments, one bundle

The same `webapp/` bundle serves two surfaces:

1. **Standalone** at `http://<host>:3004/` — direct visit, Fastify serves the bundle, API at `/api/*`.
2. **Embedded** at `https://<host>/admin/#/e/signalk_doctor` — the SignalK admin loads the [signalk-doctor](https://github.com/dirkwa/signalk-doctor) plugin's Module Federation remote, which renders an `<iframe>` pointing at the plugin's reverse proxy mounted under `/plugins/signalk-doctor/console/`. The proxy forwards to this engine container and injects `<meta name="api-base" content="/plugins/signalk-doctor/console">` into the HTML before serving it to the browser.

Contract that keeps both surfaces working:

- **`vite.config.ts` uses `base: './'`.** Asset URLs in HTML emit as `./assets/index-X.js`, so they resolve against whatever document URL the browser is on — `/` for standalone, `/plugins/signalk-doctor/console/` for embedded. Switching this to absolute would break the embedded case.
- **`webapp/src/api.ts` is the only place that reads the meta tag.** Path strings inside `api.ts` are written without the prefix; the module concatenates the meta-derived base in front. Adding a network call anywhere else means routing it through `api.ts` (or one of its exports), or it will skip the prefix.

Changing any of these is a cross-repo coordination with [signalk-doctor](https://github.com/dirkwa/signalk-doctor) — its proxy mount path and the meta tag content must match.

## Relationship to signalk-updater-server

This container is a deliberate code-twin of [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server) at the skeleton level: same Fastify factory, same `src/podman/client.ts` shape, same `src/errors.ts`, same Dockerfile pattern. They diverge once each has its real feature set:

- **Updater = mutating.** Writes Quadlets, calls `podman pull`, calls `systemctl --user restart`.
- **Doctor = read-mostly.** Reads Quadlets and journal, runs probes. Mutation is limited to recovery (restore snapshot + daemon-reload + restart) and is gated.

Lifting code between the two repos is fine and expected. When a helper proves useful in both, copy with attribution rather than introducing a monorepo. The two repos do NOT share the same web framework conventions: the updater uses TypeBox-validated routes, the doctor doesn't (its routes are simpler and the read-only ones don't need body validation; mutating ones are bare POSTs).
