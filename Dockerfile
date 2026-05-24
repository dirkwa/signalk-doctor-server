# syntax=docker/dockerfile:1.7
#
# Base: node:24-trixie-slim (Debian 13 + Node 24, official upstream).
#
# Why trixie-slim over the Chainguard Wolfi image:
#   - Standard glibc userland — dbus-tools / systemd userspace are an
#     apt-get away if we ever need them.
#   - Runs as root by default; under rootless podman that maps to the
#     host invoking user via userns, so the container can read the
#     host-mode-0600 token file at /data/token without any User= dance
#     in the Quadlet.
#   - Trixie tracks the same release line as most boat hosts (Pi OS
#     bookworm/trixie, Debian 13). Same kernel ABI, same libc, no
#     userspace surprises.
#
# Trade-off: ~210MB final image (vs ~110MB for Wolfi). Worth it for
# the operational simplicity — no userns/auth/distroless puzzles.

FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund --loglevel=warn
COPY tsconfig.json tsconfig.webapp.json vite.config.ts ./
COPY src ./src
COPY webapp ./webapp
RUN npx tsc -p tsconfig.json \
 && npx tsc -p tsconfig.webapp.json \
 && npx vite build

FROM node:24-trixie-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --loglevel=warn

FROM node:24-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3004 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info

# tini    — PID-1 signal handling.
# ca-certificates — GHCR TLS.
# systemd — provides `busctl` which we use to talk to the host user-bus
#           for daemon-reload + unit start/stop/restart. We do NOT run
#           systemd inside the container; we only use its client tool.
# dbus    — libdbus client libs that busctl links against.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates systemd dbus \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist          ./dist
COPY --from=build /app/webapp-dist   ./webapp-dist
COPY package.json                    ./

EXPOSE 3004

LABEL org.opencontainers.image.source="https://github.com/dirkwa/signalk-doctor-server" \
      org.opencontainers.image.description="SignalK doctor engine container" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.signalk.role="doctor" \
      io.signalk.persistent="true"

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","dist/index.js"]
