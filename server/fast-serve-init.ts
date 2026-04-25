// ── Fast-serve profile registration ───────────────────────────────────────
//
// Registers the built-in 'fast-serve' profile with the standby pool (Modal-
// style warm-pool semantics: always-N-ready pods, SSH-driven offload on idle,
// sub-5s wake-on-request). Gated behind the AI_GATEWAY_FAST_SERVE env flag so
// this never activates unless an operator explicitly opts in.
//
// Intended caller: server/ws/startup-tasks.ts step 5b, fire-and-forget.

import { createLogger } from '../src/logger';
import { setStandbyPoolConfig } from './standby-pool';

const log = createLogger('fast-serve-init');

/** Env flag name the operator must set to opt in. */
export const FAST_SERVE_ENV_VAR = 'AI_GATEWAY_FAST_SERVE';

/**
 * Register the fast-serve profile with the standby pool when enabled.
 * No-op unless `AI_GATEWAY_FAST_SERVE === 'true'`.
 */
export function registerFastServeProfile(): void {
  if (process.env[FAST_SERVE_ENV_VAR] !== 'true') return;
  setStandbyPoolConfig({
    profile: 'fast-serve',
    tier: 'hyperstack',
    minStandby: 2,
    maxStandby: 4,
    gpuTypes: ['NVIDIA L40'],
    dockerImage: 'marcosremar/babelcast-subtitle:latest',
    offloadOnIdle: true,
  });
  log.log('fast-serve profile registered (hyperstack, min=2, max=4, offloadOnIdle=true)');
}
