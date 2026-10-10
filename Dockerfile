# Bun pinned: see Dockerfile.production (>= 1.4.2, fault bench 2026-10-06 item 14).
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS base
WORKDIR /app

# Install wget for healthcheck (curl not available in bun image)
RUN apt-get update -qq && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
COPY scripts/ scripts/
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY sdk/ sdk/
COPY serve.ts .
COPY tsconfig.json .

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-4000}/health || exit 1

EXPOSE ${PORT:-4000}

CMD ["bun", "run", "serve.ts"]
