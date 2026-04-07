# ============================================================================
# cramkit — single-container image
# Builds the React client, then serves it via the Hono Node server
# alongside the Anthropic ingestion proxy.
#
# Uses BuildKit cache mounts so npm + Vite caches survive across rebuilds.
# Warm rebuilds (no dep changes) drop from ~3.5min → ~30-60s.
# ============================================================================

# ---------- Stage 1: build client ----------
FROM node:22-alpine AS client-build
WORKDIR /app/client

COPY client/package.json client/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY client/ ./

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_STRIPE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_STRIPE_PUBLISHABLE_KEY=$VITE_STRIPE_PUBLISHABLE_KEY

RUN --mount=type=cache,target=/app/client/node_modules/.vite npm run build

# ---------- Stage 2: build server ----------
FROM node:22-alpine AS server-build
WORKDIR /app/server

COPY server/package.json server/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY server/ ./
RUN npm run build

# ---------- Stage 3: runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY server/package.json server/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

COPY --from=server-build /app/server/dist ./dist
COPY --from=client-build /app/client/dist ./public

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "dist/index.js"]
