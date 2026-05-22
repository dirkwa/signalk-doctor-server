# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json ./
# package-lock.json is not committed (~/.npmrc disables it); use install + omit dev for runtime image.
RUN npm install --omit=dev --no-audit --no-fund --loglevel=warn

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund --loglevel=warn
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3004 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info

# Install tini for proper signal handling.
RUN apk add --no-cache tini

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

USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
