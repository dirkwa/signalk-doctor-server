# syntax=docker/dockerfile:1.7
#
# Base: cgr.dev/chainguard/node:latest (Wolfi, glibc, daily CVE rebuilds).
#
# Why Wolfi over Alpine: musl libc has bitten Node native modules (dbus-native
# pulls bindings). Wolfi is glibc-based, security-first, and the `latest` tag
# is free to pull without authentication.
#
# Why Wolfi over Debian Trixie: same glibc, smaller image (~110MB vs ~140MB),
# and the CVE-rebuild cadence is meaningful for a boat computer that may run
# unattended for weeks. Host parity is preserved at the glibc level, which is
# what matters for native bindings.

# Builder stage: Chainguard's *-dev tag includes apk + a writable filesystem
# for building TypeScript and installing npm deps.
FROM cgr.dev/chainguard/node:latest-dev AS build
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund --loglevel=warn
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM cgr.dev/chainguard/node:latest-dev AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --loglevel=warn

# Runtime stage: distroless-style Chainguard node image. Includes node + tini.
FROM cgr.dev/chainguard/node:latest AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3004 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist          ./dist
COPY webapp                          ./webapp
COPY package.json                    ./

EXPOSE 3004

LABEL org.opencontainers.image.source="https://github.com/dirkwa/signalk-doctor-server" \
      org.opencontainers.image.description="SignalK doctor engine container" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.signalk.role="doctor" \
      io.signalk.persistent="true"

# Chainguard's runtime image already runs as a non-root `node` user.
CMD ["dist/index.js"]
