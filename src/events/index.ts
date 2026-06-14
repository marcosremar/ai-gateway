/**
 * Event Bus — centralized event system for decoupled communication.
 *
 * Fixes: #987 (event-driven architecture), #996 (event sourcing)
 *
 * Usage:
 * ```ts
 * import { eventBus } from './event-bus';
 *
 * // Subscribe
 * eventBus.on('gpu.deployed', (event) => console.log(event));
 *
 * // Emit
 * eventBus.emit('gpu.deployed', { userId, gpuType, podId });
 *
 * // Subscribe once
 * eventBus.once('gpu.booted', handler);
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('event-bus');

export type EventHandler<T = unknown> = (event: T, timestamp: string) => void | Promise<void>;

export interface EventBusEvent<T = unknown> {
  type: string;
  data: T;
  timestamp: string;
  source: string;
}

class EventBus {
  private handlers = new Map<string, Array<EventHandler>>();
  // Ring buffer for history: a fixed-size array with a write cursor avoids the
  // O(n) `Array.shift()` reindex on every emit past the cap (#577). On a hot
  // bus that shift dominated emit cost; this keeps emit O(1).
  private history: Array<EventBusEvent | undefined> = [];
  private historyCursor = 0; // next write index
  private historyCount = 0; // total events ever written (for ordering)
  private maxHistory = 1000;
  private paused = false;
  /**
   * #578 — per-type history rings so getHistory(eventType) reads only that type's
   * events instead of filtering the whole 1000-entry global ring on every call.
   * Each list is chronological and bounded to maxHistory.
   */
  private historyByType = new Map<string, EventBusEvent[]>();

  /**
   * Subscribe to an event type.
   */
  on<T>(eventType: string, handler: EventHandler<T>): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(handler as EventHandler);
    log.log({ eventType, handlerCount: this.handlers.get(eventType)!.length }, 'Event handler registered');
  }

  /**
   * Subscribe once — handler is removed after first invocation.
   */
  once<T>(eventType: string, handler: EventHandler<T>): void {
    const onceHandler: EventHandler<T> = async (data, timestamp) => {
      this.off(eventType, onceHandler as EventHandler);
      await handler(data, timestamp);
    };
    this.on(eventType, onceHandler);
  }

  /**
   * Unsubscribe from an event type.
   */
  off(eventType: string, handler: EventHandler): void {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }

  /**
   * Remove all handlers for an event type (or all types if none specified).
   */
  offAll(eventType?: string): void {
    if (eventType) {
      this.handlers.delete(eventType);
    } else {
      this.handlers.clear();
    }
  }

  /**
   * Emit an event to all subscribers.
   */
  async emit<T>(eventType: string, data: T, source = 'unknown'): Promise<void> {
    if (this.paused) return;

    const event: EventBusEvent<T> = {
      type: eventType,
      data,
      timestamp: new Date().toISOString(),
      source,
    };

    // Store in history (ring buffer, O(1) write — no shift()).
    this.history[this.historyCursor] = event;
    this.historyCursor = (this.historyCursor + 1) % this.maxHistory;
    this.historyCount++;

    // Per-type ring (#578) so getHistory(type) skips the full-ring scan.
    let typeRing = this.historyByType.get(eventType);
    if (!typeRing) {
      typeRing = [];
      this.historyByType.set(eventType, typeRing);
    }
    typeRing.push(event);
    if (typeRing.length > this.maxHistory) typeRing.shift();

    // Notify handlers
    const handlers = this.handlers.get(eventType) ?? [];
    const errors: Error[] = [];

    await Promise.all(
      handlers.map(async (handler) => {
        try {
          await handler(data, event.timestamp);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          errors.push(err);
          log.error({ eventType, error: err.message }, 'Event handler failed');
        }
      }),
    );

    if (errors.length > 0) {
      log.warn({ eventType, errors: errors.length }, 'Some event handlers failed');
    }
  }

  /**
   * Read the ring buffer in chronological (oldest → newest) order.
   */
  private orderedHistory(): EventBusEvent[] {
    const n = Math.min(this.historyCount, this.maxHistory);
    const out: EventBusEvent[] = [];
    // When wrapped, the oldest entry sits at `historyCursor`; otherwise at 0.
    const start = this.historyCount > this.maxHistory ? this.historyCursor : 0;
    for (let i = 0; i < n; i++) {
      const ev = this.history[(start + i) % this.maxHistory];
      if (ev) out.push(ev);
    }
    return out;
  }

  /**
   * Get event history (chronological order, oldest first).
   */
  getHistory(eventType?: string, limit = 100): EventBusEvent[] {
    if (eventType) {
      // #578 — read the per-type ring directly; no scan over unrelated events.
      const ring = this.historyByType.get(eventType);
      return ring ? ring.slice(-limit) : [];
    }
    return this.orderedHistory().slice(-limit);
  }

  /**
   * Pause event emission (events are still queued but not delivered).
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume event emission.
   */
  resume(): void {
    this.paused = false;
  }

  /**
   * Get statistics.
   */
  getStats(): { handlerCount: number; eventTypes: number; historySize: number } {
    return {
      handlerCount: Array.from(this.handlers.values()).reduce((sum, h) => sum + h.length, 0),
      eventTypes: this.handlers.size,
      historySize: Math.min(this.historyCount, this.maxHistory),
    };
  }

  /**
   * Clear history.
   */
  clearHistory(): void {
    this.history = [];
    this.historyCursor = 0;
    this.historyCount = 0;
    this.historyByType.clear();
  }
}

/**
 * Global event bus instance.
 */
export const eventBus = new EventBus();

/**
 * Common event types for AI Gateway.
 */
export const EVENTS = {
  // GPU Events
  GPU_BOOT_STARTED: 'gpu.boot.started',
  GPU_BOOT_COMPLETED: 'gpu.boot.completed',
  GPU_BOOT_FAILED: 'gpu.boot.failed',
  GPU_STOPPED: 'gpu.stopped',
  GPU_TERMINATED: 'gpu.terminated',
  GPU_HEALTH_CHECK: 'gpu.health.check',
  GPU_IDLE_TIMEOUT: 'gpu.idle.timeout',

  // Provider Events
  PROVIDER_CALL_STARTED: 'provider.call.started',
  PROVIDER_CALL_COMPLETED: 'provider.call.completed',
  PROVIDER_CALL_FAILED: 'provider.call.failed',
  PROVIDER_RATE_LIMITED: 'provider.rate.limited',
  PROVIDER_FAILOVER: 'provider.failover',

  // Pipeline Events
  PIPELINE_STARTED: 'pipeline.started',
  PIPELINE_COMPLETED: 'pipeline.completed',
  PIPELINE_FAILED: 'pipeline.failed',
  STAGE_COMPLETED: 'pipeline.stage.completed',

  // Auth Events
  AUTH_SUCCESS: 'auth.success',
  AUTH_FAILURE: 'auth.failure',
  API_KEY_ROTATED: 'apikey.rotated',

  // Cost Events
  BUDGET_WARNING: 'budget.warning',
  BUDGET_EXCEEDED: 'budget.exceeded',
  COST_ALERT: 'cost.alert',

  // System Events
  SERVER_STARTED: 'server.started',
  SERVER_SHUTDOWN: 'server.shutdown',
  CONFIG_CHANGED: 'config.changed',
} as const;

export type EventType = (typeof EVENTS)[keyof typeof EVENTS];
