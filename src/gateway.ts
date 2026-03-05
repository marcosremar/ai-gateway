/**
 * Singleton gateway — call initGateway() once at app startup,
 * then getGateway() anywhere to retrieve the autoscaler instance.
 *
 * Uses globalThis to survive module duplication across bundler chunks
 * (Turbopack/Webpack can compile the same module into separate chunks).
 */
import { createAutoscaler, type Autoscaler, type CreateAutoscalerOptions } from './factory';

export interface InitGatewayOptions extends CreateAutoscalerOptions {}

const GATEWAY_KEY = Symbol.for('__parle_ai_gateway_instance');

type GatewayStore = { instance: Autoscaler | null };

function _store(): GatewayStore {
  const g = globalThis as unknown as Record<symbol, GatewayStore | undefined>;
  if (!g[GATEWAY_KEY]) g[GATEWAY_KEY] = { instance: null };
  return g[GATEWAY_KEY]!;
}

/** Initialize the singleton gateway. Call once at app startup. */
export function initGateway(opts: InitGatewayOptions): Autoscaler {
  const s = _store();
  s.instance = createAutoscaler(opts);
  return s.instance;
}

/** Get the initialized gateway. Throws if not yet initialized. */
export function getGateway(): Autoscaler {
  const inst = _store().instance;
  if (!inst) throw new Error('[ai-gateway] Not initialized. Call initGateway() first.');
  return inst;
}

/** Reset singleton (for tests). */
export function resetGateway(): void { _store().instance = null; }
