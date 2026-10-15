# Bun pinned: see Dockerfile.production (>= 1.4.2, fault bench 2026-10-06 item 14).
# Alpine like the production image: the Debian bun image carried unfixed util-linux/ncurses/perl HIGHs (Trivy, 2026-10-04).
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS base
WORKDIR /app

RUN apk upgrade --no-cache && apk add --no-cache wget

# Install dependencies
COPY package.json bun.lock ./
COPY scripts/ scripts/
RUN bun install --frozen-lockfile --production --ignore-scripts

# Copy source
COPY src/ src/
COPY sdk/ sdk/
COPY serve.ts .
COPY tsconfig.json .

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-4000}/health || exit 1

EXPOSE ${PORT:-4000}

CMD ["bun", "run", "serve.ts"]
