# signalk-doctor-server

Peer engine container for the SignalK container stack. Owns **read-only diagnostics + last-known-good recovery**.

This is **not a SignalK plugin** — it runs in its own container alongside `signalk-server` and is intentionally independent of `signalk-updater-server`. When the updater itself is broken (bad self-update, crashloop, DBus dead), the doctor is the path back.

> Status: **skeleton**. Only `GET /api/health` is implemented. Real probes and the recover endpoint land in Phase 5.

## Companion repos

| Repo                                                                                 | Role                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) | Bash bootstrap that drops both engine containers as systemd Quadlets.              |
| [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server)           | Sister engine container — owns the mutating side (version switching, self-update). |
| [signalk-doctor](https://github.com/dirkwa/signalk-doctor)                           | Thin-shell plugin inside signalk-server that deep-links to this container's UI.    |

## Trust boundary

This container reads the Podman socket, DBus, and `~/.config/containers/systemd/` — but mutating endpoints are narrow (recover only). Posture:

- Bound to `127.0.0.1:3004` only.
- Read-only probes are **unauthenticated** (intentional — they're the recovery surface).
- Mutating endpoints (`/api/recover*`) require `Authorization: Bearer <token>` from `~/.signalk-doctor/token` (mode 0600).

## Local dev

```bash
npm install
npm test
npm run dev   # tsx watch src/index.ts, listens on :3004
curl -s http://127.0.0.1:3004/api/health | jq .
```

To build the production image:

```bash
podman build -t signalk-doctor-server:dev .
podman run --rm -p 127.0.0.1:3004:3004 -v /run/user/$UID/podman/podman.sock:/var/run/docker.sock signalk-doctor-server:dev
```
