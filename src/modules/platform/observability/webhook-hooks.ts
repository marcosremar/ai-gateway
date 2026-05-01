/**
 * Webhook hooks — POST events to arbitrary webhook URL with batching.
 * Automatically redacts sensitive fields before sending.
 */

import { createLogger } from '../logger';
import type { GatewayHooks } from '../../hooks';
import type { WebhookConfig } from './types';

const log = createLogger('webhook-hooks');

const SENSITIVE_KEYS = new Set([
  'apiKey', 'secret', 'token', 'password', 'credential',
  'authorization', 'bearer', 'accessToken', 'refreshToken',
  'privateKey', 'hfToken', 'authId',
]);

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.has(lower) || lower.includes('secret') || lower.includes('key');
}

function redactObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (typeof obj === 'string') return '[redacted]';

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = '[redacted]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactObject(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

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
  let timerRunning = false;

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
    const redactedData = redactObject(data);
    if (queue.length >= MAX_QUEUE_SIZE) queue.splice(0, queue.length - MAX_QUEUE_SIZE + 1);
    queue.push({ hookName, data: redactedData, timestamp: new Date().toISOString() });
    if (queue.length >= batchSize) flush().catch(() => {});
    if (!timer) {
      timerRunning = false;
      timer = setInterval(async () => {
        if (timerRunning) return;
        timerRunning = true;
        try {
          await flush();
          if (queue.length === 0 && timer) {
            clearInterval(timer);
            timer = null;
          }
        } finally {
          timerRunning = false;
        }
      }, flushInterval);
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
