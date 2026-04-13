// ── Gateway Event Bus ─────────────────────────────────────────────────────────
// Simple fire-and-forget event system for GPU lifecycle, budget alerts, and
// operational events. Handlers are invoked synchronously (errors caught and
// swallowed) so emitting an event never blocks the hot path.
//
// Consumers register via onGatewayEvent(); the gateway emits via emitGatewayEvent().
// Events are also logged for audit trail.

import { createLogger } from '../src/logger';

const log = createLogger('event-bus');

// ── Types ────────────────────────────────────────────────────────────────────

/** Well-known gateway event names. */
export type GatewayEventName =
  // GPU lifecycle
  | 'gpu.deployed'
  | 'gpu.failed'
  | 'gpu.stopped'
  | 'gpu.terminated'
  // Budget alerts
  | 'budget.warning'
  | 'budget.critical'
  | 'budget.exceeded'
  // Generic (extensible)
  | (string & {});

export type GatewayEventData = Record<string, unknown>;

export type GatewayEventHandler = (event: GatewayEventName, data: GatewayEventData) => void;

// ── State ────────────────────────────────────────────────────────────────────

const handlers: GatewayEventHandler[] = [];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a handler that will be called for every gateway event.
 * Returns an unsubscribe function.
 */
export function onGatewayEvent(handler: GatewayEventHandler): () => void {
  handlers.push(handler);
  return () => {
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

/**
 * Fire-and-forget: emit an event to all registered handlers.
 * - Handler errors are caught and logged (never block the caller).
 * - Every event is also logged to the audit trail at info level.
 */
export function emitGatewayEvent(event: GatewayEventName, data: GatewayEventData): void {
  const payload: GatewayEventData = { event, timestamp: new Date().toISOString(), ...data };

  for (const h of handlers) {
    try {
      h(event, payload);
    } catch (err) {
      log.warn(`[event-bus] Handler error for "${event}":`, err);
    }
  }

  // Audit trail: truncate data to keep log lines readable
  const summary = JSON.stringify(data);
  log.log(`[event] ${event}: ${summary.length > 200 ? summary.slice(0, 200) + '...' : summary}`);
}

/**
 * Return the current number of registered handlers (useful for tests/diagnostics).
 */
export function handlerCount(): number {
  return handlers.length;
}
