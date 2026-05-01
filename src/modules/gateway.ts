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

/**
 * Initialize the singleton AI Gateway.
 *
 * Call this once at application startup to configure the gateway
 * with storage, state management, event hooks, and GPU provider credentials.
 *
 * The gateway uses globalThis to survive module duplication across
 * bundler chunks (Turbopack/Webpack can compile the same module
 * into separate chunks).
 *
 * @param opts - Gateway initialization options including storage, state store,
 *               hooks, and optional config loader
 * @returns The initialized autoscaler instance
 *
 * @example
 * ```typescript
 * // In app startup (e.g., server.ts)
 * import { initGateway } from '@ai-gateway/gateway';
 *
 * initGateway({
 *   settingsStore: prismaSettingsStore,
 *   stateStore: redisStateStore,
 *   sessionResolver: sessionResolver,
 *   hooks: {
 *     onScaleUp: (event) => notifyOps('Scaling up', event),
 *     onError: (event) => reportError(event),
 *   },
 * });
 * ```
 */
export function initGateway(opts: InitGatewayOptions): Autoscaler {
  const s = _store();
  s.instance = createAutoscaler(opts);
  return s.instance;
}

/**
 * Get the initialized singleton gateway.
 *
 * Use this to access the autoscaler from anywhere in your application
 * after calling `initGateway()`.
 *
 * @returns The autoscaler instance
 * @throws Error if `initGateway()` has not been called yet
 *
 * @example
 * ```typescript
 * import { getGateway } from '@ai-gateway/gateway';
 *
 * const gateway = getGateway();
 * const decision = await gateway.getAutoScaleDecision('user-123', config);
 * ```
 */
export function getGateway(): Autoscaler {
  const inst = _store().instance;
  if (!inst) throw new Error('[ai-gateway] Not initialized. Call initGateway() first.');
  return inst;
}

/** Reset singleton (for tests). */
export function resetGateway(): void { _store().instance = null; }
