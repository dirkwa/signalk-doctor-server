# signalk-doctor-server

Peer engine container for the SignalK container stack. Owns **read-only diagnostics + last-known-good recovery**.

This is **not a SignalK plugin** — it runs in its own container alongside `signalk-server` and is intentionally independent of `signalk-updater-server`. When the updater itself is broken (bad self-update, crashloop, DBus dead), the doctor is the path back.

It runs a set of read-only health probes (`GET /api/probes`) — container/runtime state, SignalK and updater health, disk/memory, version and dependency drift, host↔container **timezone drift**, and more — plus last-known-good recovery, targeted plugin-dependency heal, and a bundled bug-report collector. The browser console (Health / Logs / Snapshots / Drift / Recovery / Bug report / Installer tabs) is served from `:3004` and also embeds in the SignalK admin via the [signalk-doctor](https://github.com/dirkwa/signalk-doctor) plugin.

## Companion repos

| Repo                                                                                 | Role                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) | Bash bootstrap that drops both engine containers as systemd Quadlets.              |
| [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server)           | Sister engine container — owns the mutating side (version switching, self-update). |
| [signalk-doctor](https://github.com/dirkwa/signalk-doctor)                           | Thin-shell plugin inside signalk-server that deep-links to this container's UI.    |

## Trust boundary

This container reads the Podman socket, DBus, and `~/.config/containers/systemd/` — but its mutating surface is deliberately narrow. Posture:

- Bound to `127.0.0.1:3004` only (LAN-exposed only when installed with `SIGNALK_LAN_EXPOSE=true`).
- Read-only probes and views are **unauthenticated** (intentional — they're the recovery surface that must always answer).
- Mutating endpoints require `Authorization: Bearer <token>` from `~/.signalk-doctor/token` (mode 0600): `POST /api/recover{,/updater}` (restore last-known-good), `POST /api/restart/signalk-server` (recreate signalk-server — e.g. to apply a new host timezone), `POST /api/installer/refresh`, `POST /api/bug-report`, and `POST /api/drift/{refresh,heal}`.

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
