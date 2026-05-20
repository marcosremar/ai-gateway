import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    browser: 'src/browser/index.ts',
    providers: 'src/providers/index.ts',
    autoscaler: 'src/autoscaler/index.ts',
    'gpu-providers': 'src/gpu-providers/index.ts',
    handlers: 'src/handlers/index.ts',
    client: 'src/client/index.ts',
    tracking: 'src/tracking/index.ts',
    adapters: 'src/adapters/index.ts',
    auth: 'src/auth/index.ts',
    infra: 'src/infra/index.ts',
    benchmarking: 'src/benchmarking/index.ts',
    vault: 'src/vault/index.ts',
    observability: 'src/observability/index.ts',
    alerting: 'src/alerting/index.ts',
    caching: 'src/caching/index.ts',
    proxy: 'src/proxy/index.ts',
    workloads: 'src/workloads/index.ts',
    'object-storage': 'src/object-storage/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: {
    compilerOptions: {
      composite: false,
      noUnusedLocals: false,
      noUnusedParameters: false,
    },
  },
  // Keep entry bundles self-contained. Code splitting produced empty chunks and
  // mixed default/named export warnings for barrel-heavy public entry points.
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  target: 'es2017',
  external: ['openai', 'zod', '@pipecat-ai/client-js', '@pipecat-ai/small-webrtc-transport'],
  treeshake: true,
});
