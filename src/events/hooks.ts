/**
 * Observability Hooks — fire-and-forget event system for the AI Gateway.
 *
 * All hooks are optional. Errors thrown by hook callbacks are caught and
 * swallowed (logged via logger.warn) so they never break the hot path.
 */

import { defaultLogger } from '../logger';

// ── Event payloads ────────────────────────────────────────────────────────────

export interface RequestStartEvent {
  userId: string;
  stage: 'stt' | 'llm' | 'tts' | 'pipeline';
  provider: string;
  model?: string;
  timestamp: number;
}

export interface RequestEndEvent {
  userId: string;
  stage: 'stt' | 'llm' | 'tts' | 'pipeline';
  provider: string;
  model?: string;
  latencyMs: number;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface FallbackEvent {
  userId: string;
  stage: 'stt' | 'llm' | 'tts';
  fromProvider: string;
  toProvider: string;
  fromModel?: string;
  toModel?: string;
  reason: string;
  timestamp: number;
}

export interface ScaleUpEvent {
  userId: string;
  tierIndex: number;
  provider: string;
  trigger: string;
  activeSessions: number;
  timestamp: number;
}

export interface ScaleDownEvent {
  userId: string;
  tierIndex: number;
  provider: string;
  reason: string;
  idleMinutes: number;
  timestamp: number;
}

export interface CostAlertEvent {
  userId: string;
  provider: string;
  instanceId: string;
  instanceName?: string;
  alertType: 'orphaned' | 'stale' | 'budget_exceeded';
  message: string;
  timestamp: number;
}

export interface HealthChangeEvent {
  userId: string;
  tierIndex: number;
  provider: string;
  previousState: string;
  newState: string;
  endpoint?: string;
  timestamp: number;
}

export interface ErrorEvent {
  userId?: string;
  source: 'gpu-provider' | 'autoscaler' | 'health-checker' | 'cost-monitor' | 'watchdog' | 'cleanup' | 'request';
  provider?: string;
  instanceId?: string;
  tierIndex?: number;
  operation: string;
  message: string;
  errorCode?: string;
  httpStatus?: number;
  retryable: boolean;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

// ── Hook interface ────────────────────────────────────────────────────────────

export interface GatewayHooks {
  onRequestStart?: (event: RequestStartEvent) => void | Promise<void>;
  onRequestEnd?: (event: RequestEndEvent) => void | Promise<void>;
  onFallback?: (event: FallbackEvent) => void | Promise<void>;
  onScaleUp?: (event: ScaleUpEvent) => void | Promise<void>;
  onScaleDown?: (event: ScaleDownEvent) => void | Promise<void>;
  onCostAlert?: (event: CostAlertEvent) => void | Promise<void>;
  onHealthChange?: (event: HealthChangeEvent) => void | Promise<void>;
  onError?: (event: ErrorEvent) => void | Promise<void>;
}

// ── Emitter ───────────────────────────────────────────────────────────────────

type HookName = keyof GatewayHooks;
type HookPayloadMap = {
  onRequestStart: RequestStartEvent;
  onRequestEnd: RequestEndEvent;
  onFallback: FallbackEvent;
  onScaleUp: ScaleUpEvent;
  onScaleDown: ScaleDownEvent;
  onCostAlert: CostAlertEvent;
  onHealthChange: HealthChangeEvent;
  onError: ErrorEvent;
};

/**
 * Emit a gateway event hook.
 *
 * Hooks allow external systems to react to gateway events like GPU deployment,
 * provider failures, and budget alerts. All hooks are optional and fire-and-forget —
 * errors thrown by hook callbacks are caught and logged so they never break the hot path.
 *
 * @param hooks - The gateway hooks configuration (may be undefined)
 * @param event - The hook event name to emit (e.g., 'onScaleUp', 'onError')
 * @param data - Event payload specific to the event type
 *
 * @example
 * ```typescript
 * // Emit a scale-up event
 * emitHook(hooks, 'onScaleUp', {
 *   userId: 'user-123',
 *   tierIndex: 0,
 *   provider: 'runpod',
 *   trigger: 'session_threshold',
 *   activeSessions: 5,
 *   timestamp: Date.now(),
 * });
 * ```
 */
export function emitHook<K extends HookName>(
  hooks: GatewayHooks | undefined,
  event: K,
  data: HookPayloadMap[K],
): void {
  if (!hooks) return;
  const fn = hooks[event] as ((data: HookPayloadMap[K]) => void | Promise<void>) | undefined;
  if (!fn) return;
  try {
    const result = fn(data);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((err) =>
        defaultLogger.warn(`[hooks] ${event} async error:`, err),
      );
    }
  } catch (err) {
    defaultLogger.warn(`[hooks] ${event} sync error:`, err);
  }
}
