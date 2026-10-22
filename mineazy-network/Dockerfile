# syntax=docker/dockerfile:1
# =============================================================================
#  Mineazy Network — container image
# =============================================================================
#
#  The same image runs both services in docker-compose.yml:
#
#    console   — `npm run start`     (the Next.js web console)
#    collector — `npm run collector` (the monitoring engine)
#
#  The image is deliberately NOT built with `output: "standalone"`, because the
#  collector is executed straight from the TypeScript sources with `tsx` and
#  therefore needs the source tree and the dev dependency `tsx` at runtime.
#  A production runtime image without the sources would only be able to run
#  the console, which is not how this product is deployed.
# =============================================================================

# -----------------------------------------------------------------------------
# Base — Debian slim + the two network utilities the probes need
# -----------------------------------------------------------------------------
#   iputils-ping → the ICMP probe shells out to the platform `ping`
#   iproute2     → `ip neigh show`, used to read the local ARP/neighbour table
FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        iputils-ping \
        iproute2 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Dependencies
# -----------------------------------------------------------------------------
FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci

# -----------------------------------------------------------------------------
# Build
# -----------------------------------------------------------------------------
FROM base AS builder

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The build must never start a collector. `instrumentation.ts` already skips
# itself during the build phase, and the collector is disabled explicitly so a
# stray environment variable can never make the build poll the network.
ENV MINEAZY_INLINE_COLLECTOR=0
ENV MINEAZY_DEMO=0

RUN npm run build

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
FROM base AS runner

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=builder /app/.next        ./.next
COPY --from=builder /app/src          ./src
COPY --from=builder /app/scripts      ./scripts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=builder /app/next-env.d.ts ./next-env.d.ts

# The database, the generated secret key and the collector lock all live here.
RUN mkdir -p /app/data && chown -R node:node /app

ENV MINEAZY_DB_PATH=/app/data/mineazy.db
ENV MINEAZY_SECRET_KEY_FILE=/app/data/secret.key
ENV MINEAZY_INLINE_COLLECTOR=0
ENV HOSTNAME=0.0.0.0
ENV PORT=3100

USER node
WORKDIR /app
EXPOSE 3100

# The container is a server; there is nothing to "open" once it is running.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3100/api/demo').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
