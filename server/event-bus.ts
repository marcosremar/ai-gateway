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

/** Per-event-name count of handler exceptions (for diagnostics / metrics). */
const handlerErrorCounts: Record<string, number> = {};

// ── Bounded event history (#579) ──────────────────────────────────────────────
// The server bus previously only logged a truncated line and kept NO queryable
// history, so budget / GPU-lifecycle events could not be inspected after the
// fact via a diagnostics endpoint. Keep a bounded ring (matching the `src` bus's
// 1000-event cap) so recent events are introspectable without unbounded growth.

export interface GatewayEventRecord {
  event: GatewayEventName;
  data: GatewayEventData;
  timestamp: string;
}

const MAX_EVENT_HISTORY = 1000;
const eventHistory: Array<GatewayEventRecord | undefined> = [];
let historyCursor = 0;
let historyCount = 0;

/**
 * Whether the audit-trail `JSON.stringify` is worth doing (#581).
 * When LOG_LEVEL is above info (warn/error/silent) the audit line is dropped
 * anyway, so stringifying the full payload just to truncate it is wasted CPU on
 * a hot bus. Computed once at module load from the same env pino reads.
 */
const AUDIT_LEVEL_ENABLED = (() => {
  const lvl = (process.env.LOG_LEVEL ?? '').toLowerCase();
  // Only suppress when explicitly set to a level above info.
  return !(lvl === 'warn' || lvl === 'error' || lvl === 'fatal' || lvl === 'silent');
})();

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
  const ts = new Date().toISOString();
  const payload: GatewayEventData = { event, timestamp: ts, ...data };

  // Record in the bounded ring (O(1) write, no shift()).
  eventHistory[historyCursor] = { event, data: payload, timestamp: ts };
  historyCursor = (historyCursor + 1) % MAX_EVENT_HISTORY;
  historyCount++;

  for (const h of handlers) {
    try {
      h(event, payload);
    } catch (err) {
      // Count handler failures per event name. A consistently-throwing handler
      // (e.g. a broken alert sink) was previously invisible — only a log line.
      handlerErrorCounts[event] = (handlerErrorCounts[event] ?? 0) + 1;
      log.warn(`[event-bus] Handler error for "${event}":`, err);
    }
  }

  // Audit trail: truncate data to keep log lines readable. Skip the
  // JSON.stringify entirely when the audit level is suppressed (#581) — for a
  // high-frequency bus this avoids stringifying a payload nobody will see.
  if (AUDIT_LEVEL_ENABLED) {
    const summary = JSON.stringify(data);
    log.log(`[event] ${event}: ${summary.length > 200 ? summary.slice(0, 200) + '...' : summary}`);
  }
}

/**
 * Return recent gateway events (chronological, oldest first), optionally
 * filtered by event name. Bounded to the last {@link MAX_EVENT_HISTORY} events.
 */
export function getEventHistory(event?: GatewayEventName, limit = 100): GatewayEventRecord[] {
  const n = Math.min(historyCount, MAX_EVENT_HISTORY);
  const start = historyCount > MAX_EVENT_HISTORY ? historyCursor : 0;
  const out: GatewayEventRecord[] = [];
  for (let i = 0; i < n; i++) {
    const rec = eventHistory[(start + i) % MAX_EVENT_HISTORY];
    if (rec && (!event || rec.event === event)) out.push(rec);
  }
  return out.slice(-limit);
}

/** Clear the event history ring (tests / diagnostics). */
export function clearEventHistory(): void {
  for (let i = 0; i < eventHistory.length; i++) eventHistory[i] = undefined;
  historyCursor = 0;
  historyCount = 0;
}

/**
 * Return the current number of registered handlers (useful for tests/diagnostics).
 */
export function handlerCount(): number {
  return handlers.length;
}

/**
 * Total handler exceptions across all events, or for a single event name.
 * Surfaces silently-failing handlers (broken alert/metric sinks) to /metrics.
 */
export function handlerErrorCount(event?: GatewayEventName): number {
  if (event) return handlerErrorCounts[event] ?? 0;
  let total = 0;
  for (const n of Object.values(handlerErrorCounts)) total += n;
  return total;
}
