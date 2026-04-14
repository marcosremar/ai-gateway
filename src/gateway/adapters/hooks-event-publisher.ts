/**
 * HooksEventPublisher — bridges the Clean Architecture EventPublisher port
 * to the existing fire-and-forget Hooks system (src/events/hooks.ts).
 */

import type { EventPublisher, DomainEvent } from '../ports/event-publisher';

export interface HooksSink {
  onRequestEnd?: (payload: Record<string, unknown>) => void;
  onScaleUp?: (payload: Record<string, unknown>) => void;
  onScaleDown?: (payload: Record<string, unknown>) => void;
  onCostAlert?: (payload: Record<string, unknown>) => void;
  onError?: (payload: Record<string, unknown>) => void;
  onHealthChange?: (payload: Record<string, unknown>) => void;
}

/** Maps domain event types to hooks. Silent for unknown event types. */
const EVENT_TO_HOOK: Record<string, keyof HooksSink> = {
  'deploy.started': 'onScaleUp',
  'deploy.ready': 'onHealthChange',
  'deploy.stopped': 'onScaleDown',
  'deploy.failed': 'onError',
  'deploy.rejected': 'onCostAlert',
  'pipeline.completed': 'onRequestEnd',
};

export class HooksEventPublisher implements EventPublisher {
  constructor(private readonly hooks: HooksSink) {}

  publish(event: DomainEvent): void {
    const hookName = EVENT_TO_HOOK[event.type];
    if (!hookName) return;
    const fn = this.hooks[hookName];
    if (typeof fn === 'function') {
      try {
        fn({ ...event.payload, eventType: event.type, timestamp: event.timestamp });
      } catch {
        /* hooks are fire-and-forget — never break the caller */
      }
    }
  }
}
