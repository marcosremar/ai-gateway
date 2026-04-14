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
  private history: EventBusEvent[] = [];
  private maxHistory = 1000;
  private paused = false;

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

    // Store in history
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

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
   * Get event history.
   */
  getHistory(eventType?: string, limit = 100): EventBusEvent[] {
    const events = eventType
      ? this.history.filter((e) => e.type === eventType)
      : this.history;
    return events.slice(-limit);
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
      historySize: this.history.length,
    };
  }

  /**
   * Clear history.
   */
  clearHistory(): void {
    this.history = [];
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
