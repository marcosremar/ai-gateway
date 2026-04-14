import { defineConfig } from 'vitest/config';
import path from 'path';

const root = __dirname;
const src = (p: string) => path.resolve(root, 'src', p);
const tests = (p: string) => path.resolve(root, '__tests__', p);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ai-gateway\/(.*)$/, replacement: `${path.resolve(root, 'src')}/$1` },
      { find: '@ai-gateway', replacement: path.resolve(root, 'src/index.ts') },
      { find: '@prisma/client', replacement: tests('__mocks__/prisma-client-mock.ts') },

      // ── SDK paths ──────────────────────────────────────────────────────
      { find: 'sdk/node/audio', replacement: src('sdk/node/audio.ts') },
      { find: /^(\.\.?\/)+sdk\/node$/, replacement: path.resolve(root, 'sdk/node/index.ts') },
      // Specific file-level aliases for local imports
      { find: './gpu-deploy', replacement: path.resolve(root, 'server/gpu-deploy.ts') },
      { find: './deployment-state-machine', replacement: path.resolve(root, 'server/deployment-state-machine.ts') },

      // ── src/ path reorganizations (DDD migration) ──────────────────────
      { find: /^(\.\.\/)+(src\/)?observability\/console-hooks$/, replacement: src('platform/observability/console-hooks.ts') },
      { find: /^(\.\.\/)+(src\/)?observability\/webhook-hooks$/, replacement: src('platform/observability/webhook-hooks.ts') },
      { find: /^(\.\.?\/)+src\/logger$/, replacement: src('logger.ts') },
      { find: /^(\.\.\/)+src\/logger$/, replacement: src('logger.ts') },
      { find: /src\/logger$/, replacement: src('logger.ts') },
      { find: /^(\.\.\/)+(src\/)?database\/pg-driver$/, replacement: src('database/pg-driver.ts') },
      { find: /^(\.\.\/)+(src\/)?gpu-providers\/deploy-settings$/, replacement: src('config/index.ts') },
      { find: /^(\.\.\/)+(src\/)?workloads\/registry$/, replacement: src('compute/workloads/index.ts') },
      { find: /^(\.\.\/)+(src\/)?workloads\/types$/, replacement: src('compute/workloads/types.ts') },
      { find: /^(\.\.\/)+(src\/)?vault\/vault$/, replacement: src('auth/vault/vault.ts') },
      { find: /^(\.\.\/)+(src\/)?providers\/openai-compat\/openai-compat-embedding$/, replacement: src('gateway/providers/cloud/openai-compat/openai-compat-embedding.ts') },
      { find: /^(\.\.\/)+(src\/)?providers\/openai-compat\/client-cache$/, replacement: src('gateway/providers/cloud/openai-compat/client-cache.ts') },
      { find: /^(\.\.\/)+(src\/)?providers\/openai-compat\/audio-utils$/, replacement: src('gateway/providers/cloud/openai-compat/audio-utils.ts') },
      { find: /^(\.\.\/)+(src\/)?providers\/groq\/models$/, replacement: src('gateway/providers/cloud/groq/models.ts') },
      { find: /^(\.\.\/)+(src\/)?providers\/rerank\/openrouter-rerank$/, replacement: src('gateway/providers/cloud/rerank/openrouter-rerank.ts') },
      { find: /^(\.\.\/)+(src\/)?providers\/rerank\/fireworks-rerank$/, replacement: src('gateway/providers/cloud/rerank/fireworks-rerank.ts') },
      { find: /^(\.\.\/)+(src\/)?observability\/merge-hooks$/, replacement: src('platform/observability/merge-hooks.ts') },
      { find: /^(\.\.\/)+(src\/)?observability\/langfuse-hooks$/, replacement: src('platform/observability/langfuse-hooks.ts') },
      { find: /^(\.\.\/)+(src\/)?infra\/gpu-backend$/, replacement: src('infra/gpu-backend.ts') },
      { find: /^(\.\.\/)+(src\/)?index$/, replacement: src('index.ts') },
      { find: /^(\.\.\/)+(src\/)?browser\/openai-realtime$/, replacement: src('browser/openai-realtime.ts') },
      { find: /^(\.\.\/)+(src\/)?contracts$/, replacement: src('contracts/index.ts') },
      { find: /^(\.\.\/)+(src\/)?language-detect$/, replacement: src('language-detect.ts') },
      { find: /^(\.\.\/)+(src\/)?caching\/response-cache$/, replacement: src('caching/response-cache.ts') },
      { find: /^(\.\.\/)+(src\/)?browser\/speech-client$/, replacement: src('browser/speech-client.ts') },
      { find: /^(\.\.\/)+(src\/)?browser\/emitter$/, replacement: src('browser/emitter.ts') },
      { find: /^(\.\.\/)+(src\/)?auth\/gpu-token$/, replacement: src('auth/gpu-token.ts') },
      { find: /^(\.\.\/)+(src\/)?browser\/logger$/, replacement: src('browser/logger.ts') },
      { find: /^(\.\.\/)+(src\/)?browser\/unified-client$/, replacement: src('browser/unified-client.ts') },
      { find: /^(\.\.\/)+(src\/)?utils$/, replacement: src('utils/index.ts') },
      { find: /^(\.\.\/)+(src\/)?errors$/, replacement: src('errors/index.ts') },
      { find: /^(\.\.\/)+(src\/)?constants$/, replacement: src('constants/index.ts') },
    ],
  },
  test: {
    include: ['__tests__/**/*.test.ts'],
    setupFiles: ['__tests__/vitest-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    retry: 1,
    changed: true,
    env: {
      SKIP_GPU_TESTS: process.env.SKIP_GPU_TESTS ?? '1',
      SKIP_LIVE_TESTS: process.env.SKIP_LIVE_TESTS ?? '1',
    },
    server: {
      deps: {
        inline: ['zod'],
      },
    },
  },
});
