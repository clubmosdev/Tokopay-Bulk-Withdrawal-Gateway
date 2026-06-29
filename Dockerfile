# TOKOPAY bulk withdrawal gateway.
# Single process: HTTP API + in-process parallel worker + embedded PGlite DB.
FROM node:20.23.1-slim

WORKDIR /app

# Install deps first (better layer caching).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    # tsx is a devDependency but we run TS directly in prod; install it too.
    && npm install tsx@^4.19.2 --no-audit --no-fund

# App source.
COPY tsconfig.json ./
COPY src ./src

# Persisted embedded-database location (mount a volume here).
ENV PGDATA_DIR=/app/pgdata
ENV PORT=8080
RUN mkdir -p /app/pgdata && chown -R node:node /app

USER node
EXPOSE 8080

# Lightweight container healthcheck hitting /health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
