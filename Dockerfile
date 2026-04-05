FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY sdk/ sdk/
COPY serve.ts .
COPY tsconfig.json .

EXPOSE ${PORT:-4000}

CMD ["bun", "run", "serve.ts"]
