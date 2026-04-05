FROM oven/bun:1 AS base
WORKDIR /app

# Install wget for healthcheck (curl not available in bun image)
RUN apt-get update -qq && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY sdk/ sdk/
COPY serve.ts .
COPY tsconfig.json .

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-4000}/health || exit 1

EXPOSE ${PORT:-4000}

CMD ["bun", "run", "serve.ts"]
