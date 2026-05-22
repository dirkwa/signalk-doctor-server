# signalk-doctor-server

Peer engine container for the SignalK container stack. Owns **diagnostics and last-known-good recovery**. Runs alongside (not inside) `signalk-server`, independent of `signalk-updater-server`.

## Architecture facts you must keep in mind

- **Not a SignalK plugin.** Standalone Node 24 container started by systemd-user via a Quadlet that the bash installer drops at `~/.config/containers/systemd/signalk-doctor-server.container`.
- **Independent of the updater.** When the updater is broken (bad self-update, crashloop, DBus dead), this is the path back. It must work when nothing else does.
- **Read-only by default.** Probes don't mutate. Only `POST /api/recover` and `POST /api/recover/updater` change anything, and they're gated behind bearer-token auth.
- **Owns Quadlet snapshots.** Writes by the updater (or this container during recovery) live under `~/.signalk-doctor/snapshots/<timestamp>-<filename>` (CC-1). `~/.signalk-doctor/last-good.json` records the validated last-known-good set of tags.
- **Recovery surface is unauthenticated.** Read-only probes do not require a token — they're the way a desperate user discovers what's broken. Only mutating endpoints (`/api/recover*`) require auth.

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
cr review --plain | tee /tmp/cr-review-<branch>.txt
```

Skip `cr review` only for `chore(release): X.Y.Z` PRs.

### Release flow

Tag `vX.Y.Z` triggers `.github/workflows/publish.yml` which builds a multi-arch image and pushes to `ghcr.io/dirkwa/signalk-doctor-server:X.Y.Z` plus moving tags (`:X.Y`, `:X`, `:latest` for stable, `:beta` for prereleases). Never publish without explicit approval.

## File layout

| Path                            | Purpose                                         |
| ------------------------------- | ----------------------------------------------- |
| `src/index.ts`                  | Entrypoint. Starts fastify.                     |
| `src/server.ts`                 | Fastify factory.                                |
| `src/auth.ts`                   | Bearer-token middleware (CC-2).                 |
| `src/errors.ts`                 | Error categorization (CC-6).                    |
| `src/podman/client.ts`          | dockerode wrapper + runtime detection.          |
| `src/routes/health.ts`          | `GET /api/health`.                              |
| `src/types.ts`                  | TypeScript contracts.                           |
| `webapp/`                       | Browser UI (Doctor Console — built in Phase 5). |
| `Dockerfile`                    | Multi-stage Node 24 Alpine.                     |
| `.github/workflows/ci.yml`      | PR lint + build + test.                         |
| `.github/workflows/publish.yml` | Tag-triggered multi-arch buildx → GHCR.         |

## Container mounts (final shape — built up across phases)

| Host path                           | Container path         | Mode | Phase added              |
| ----------------------------------- | ---------------------- | ---- | ------------------------ |
| `/run/user/$UID/podman/podman.sock` | `/var/run/docker.sock` | rw   | 3                        |
| `~/.signalk-doctor`                 | `/data`                | rw   | 3                        |
| `~/.config/containers/systemd`      | `/quadlets`            | rw   | 5                        |
| `/run/user/$UID/bus`                | `/host/dbus`           | ro   | 5                        |
| `~/.signalk-updater`                | `/updater-data`        | ro   | 5 (for shared lock file) |

## Relationship to signalk-updater-server

This container is a deliberate code-twin of [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server) at the skeleton level: same Fastify factory, same `src/podman/client.ts` shape, same `src/errors.ts`, same Dockerfile pattern. They diverge once each has its real feature set:

- **Updater = mutating.** Writes Quadlets, calls `podman pull`, calls `systemctl --user restart`.
- **Doctor = read-mostly.** Reads Quadlets and journal, runs probes. Mutation is limited to recovery (restore snapshot + daemon-reload + restart) and is gated.

Lifting code between the two repos is fine and expected. When a helper proves useful in both, copy with attribution rather than introducing a monorepo.
