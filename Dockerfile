# ============================================================================
# cramkit — single-container image
# Builds the React client, then serves it via the Hono Node server
# alongside the Anthropic ingestion proxy.
# ============================================================================

# ---------- Stage 1: build client ----------
FROM node:22-alpine AS client-build
WORKDIR /app

COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm install --no-audit --no-fund

COPY client/ ./client/

# Build args injected by docker-compose
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_STRIPE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_STRIPE_PUBLISHABLE_KEY=$VITE_STRIPE_PUBLISHABLE_KEY

RUN cd client && npm run build

# ---------- Stage 2: build server ----------
FROM node:22-alpine AS server-build
WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --no-audit --no-fund

COPY server/ ./server/
RUN cd server && npm run build

# ---------- Stage 3: runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Install only production deps
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy compiled server and built client
COPY --from=server-build /app/server/dist ./dist
COPY --from=client-build /app/client/dist ./public

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

# Run via tini-style init so SIGTERM reaches Node directly for graceful shutdown
CMD ["node", "dist/index.js"]
