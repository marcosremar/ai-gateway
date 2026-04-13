/**
 * Webhook hooks — POST events to arbitrary webhook URL with batching.
 */

import { createLogger } from '../logger';
import type { GatewayHooks } from '../hooks';
import type { WebhookConfig } from './types';

const log = createLogger('webhook-hooks');

type HookName = keyof GatewayHooks;

interface QueuedEvent {
  hookName: string;
  data: unknown;
  timestamp: string;
}

export function createWebhookHooks(config: WebhookConfig): Partial<GatewayHooks> {
  const batchSize = config.batchSize || 10;
  const flushInterval = config.flushIntervalMs || 5000;
  const allowedEvents = config.events ? new Set(config.events) : null;
  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  async function flush(): Promise<void> {
    if (queue.length === 0) return;
    const batch = queue.splice(0, batchSize);
    try {
      await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers,
        },
        body: JSON.stringify({ events: batch }),
      });
    } catch (err) {
      log.error('Failed to deliver webhook batch', {
        url: config.url,
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const MAX_QUEUE_SIZE = 500;

  function enqueue(hookName: string, data: unknown): void {
    if (allowedEvents && !allowedEvents.has(hookName)) return;
    // Drop oldest events if queue is too large (webhook endpoint may be down)
    if (queue.length >= MAX_QUEUE_SIZE) queue.splice(0, queue.length - MAX_QUEUE_SIZE + 1);
    queue.push({ hookName, data, timestamp: new Date().toISOString() });
    if (queue.length >= batchSize) flush().catch(() => {}); // async flush, errors handled inside
    if (!timer) {
      timer = setInterval(() => {
        flush().catch(() => {}); // errors handled inside flush()
        if (queue.length === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      }, flushInterval);
      // Allow process to exit without waiting for flush timer
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    }
  }

  const hooks: Partial<GatewayHooks> = {};
  const hookNames: HookName[] = [
    'onRequestStart', 'onRequestEnd', 'onFallback',
    'onScaleUp', 'onScaleDown', 'onCostAlert', 'onHealthChange', 'onError',
  ];

  for (const name of hookNames) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (hooks as any)[name] = (data: unknown) => enqueue(name, data);
  }

  return hooks;
}
