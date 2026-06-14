/**
 * Webhook delivery system for AI Gateway events.
 *
 * Delivers events to external HTTP endpoints with retry, backoff, and dead letter queue.
 *
 * Supported events:
 * - gpu.deployed
 * - gpu.stopped
 * - gpu.terminated
 * - gpu.health_failed
 * - budget.exceeded
 * - provider.failed
 * - pipeline.completed
 *
 * @example
 * ```ts
 * import { createWebhookDelivery } from './webhooks';
 *
 * const delivery = createWebhookDelivery({
 *   url: 'https://my-app.com/webhooks',
 *   secret: 'whsec_xxx', // for HMAC signing
 *   retries: 3,
 * });
 *
 * await delivery.send({
 *   event: 'pipeline.completed',
 *   data: { userId: 'abc', latencyMs: 1234 },
 * });
 * ```
 */

import { createHash, createHmac } from 'crypto';
import { createLogger } from '../logger';
import { withRetry } from '../utils';

const log = createLogger('webhooks');

export interface WebhookEvent {
  /** Event type (e.g., 'gpu.deployed', 'pipeline.completed') */
  event: string;
  /** Event timestamp (ISO) */
  timestamp?: string;
  /** Event payload */
  data: Record<string, unknown>;
  /** Unique event ID */
  id?: string;
}

export interface WebhookConfig {
  /** Webhook endpoint URL */
  url: string;
  /** Secret for HMAC signing (optional) */
  secret?: string;
  /** Max delivery attempts (default: 3) */
  retries?: number;
  /** Timeout per attempt in ms (default: 10_000) */
  timeoutMs?: number;
  /** Max events retained in the in-memory dead-letter queue (default: 1000). */
  maxDeadLetters?: number;
  /** Called on delivery failure after all retries */
  onDeadLetter?: (event: WebhookEvent, error: Error) => void;
}

const DEFAULT_CONFIG: Required<Omit<WebhookConfig, 'url' | 'secret' | 'onDeadLetter'>> &
  Pick<WebhookConfig, 'url' | 'secret' | 'onDeadLetter'> = {
  retries: 3,
  timeoutMs: 10_000,
  maxDeadLetters: 1000,
  url: '',
  secret: undefined,
  onDeadLetter: undefined,
};

/**
 * Sign a webhook payload with HMAC.
 */
export function signWebhook(payload: WebhookEvent, secret: string): string {
  const body = JSON.stringify(payload);
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Sign over a canonical `timestamp.body` string so the signature commits to the
 * delivery time (#498). A receiver recomputes `HMAC(timestamp + '.' + rawBody)`
 * and rejects requests whose `X-Webhook-Timestamp` is too old, preventing
 * indefinite replay of a captured request. The exact body string passed here
 * must be the same bytes sent on the wire.
 */
export function signWebhookV2(rawBody: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Verify a v2 (timestamped) webhook signature and freshness (#498). Returns
 * false if the signature mismatches or the timestamp is older than
 * `toleranceMs` (default 5 min) — the server-side replay guard.
 */
export function verifyWebhookV2(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
  toleranceMs = 5 * 60 * 1000,
): boolean {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > toleranceMs) return false;
  const expected = signWebhookV2(rawBody, timestamp, secret);
  // Length-checked constant-ish comparison (hex strings of equal length).
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/**
 * Create a webhook delivery instance.
 */
export function createWebhookDelivery(config: WebhookConfig) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const deadLetters: Array<{ event: WebhookEvent; error: Error; attempts: number }> = [];

  return {
    /**
     * Send a webhook event with retry and backoff.
     */
    async send(event: WebhookEvent): Promise<boolean> {
      const eventId = event.id ?? crypto.randomUUID();
      const enrichedEvent: WebhookEvent = {
        ...event,
        id: eventId,
        timestamp: event.timestamp ?? new Date().toISOString(),
      };

      // Serialize once so the bytes signed match the bytes sent (#498).
      const rawBody = JSON.stringify(enrichedEvent);
      const sigTimestamp = enrichedEvent.timestamp!;
      const signature = cfg.secret ? signWebhook(enrichedEvent, cfg.secret) : undefined;
      // v2 signature commits to the timestamp to block replay.
      const signatureV2 = cfg.secret ? signWebhookV2(rawBody, sigTimestamp, cfg.secret) : undefined;

      // SSRF guard — webhook URL is operator-supplied via config; refuse
      // private/metadata hosts so a misconfigured webhook can't probe
      // internal services or replay HMAC-signed payloads back to the gateway.
      try {
        const { isPrivateUrlResolved } = await import('../gateway/pipeline/ssrf-protection');
        if (await isPrivateUrlResolved(cfg.url)) {
          log.warn({ url: cfg.url, eventId }, 'Webhook target resolves to private address — refusing');
          return false;
        }
      } catch { /* ssrf module optional in test env */ }
      try {
        await withRetry(
          async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

            try {
              const response = await fetch(cfg.url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(signature
                    ? {
                        'X-Webhook-Signature': signature,
                        'X-Webhook-Signature-V2': signatureV2!,
                        'X-Webhook-Timestamp': sigTimestamp,
                        'X-Webhook-Event': enrichedEvent.event,
                        'X-Webhook-Id': eventId,
                      }
                    : {}),
                },
                body: rawBody,
                signal: controller.signal,
              });

              clearTimeout(timeout);

              if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
              }

              log.log({ event: enrichedEvent.event, eventId, url: cfg.url }, 'Webhook delivered');
            } catch (err) {
              clearTimeout(timeout);
              throw err;
            }
          },
          {
            maxAttempts: cfg.retries,
            baseDelayMs: 1_000,
            maxDelayMs: 30_000,
          },
        );

        return true;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log.log(
          { event: enrichedEvent.event, eventId, error: err.message, url: cfg.url },
          'Webhook delivery failed — moving to dead letter queue',
        );

        // Bound the in-memory DLQ so sustained delivery failures can't grow it
        // without limit (#497). Drop the oldest entry when at capacity. (Retry
        // backoff jitter is already provided by withRetry's `jitter` option.)
        deadLetters.push({ event: enrichedEvent, error: err, attempts: cfg.retries });
        while (deadLetters.length > cfg.maxDeadLetters) deadLetters.shift();

        if (cfg.onDeadLetter) {
          cfg.onDeadLetter(enrichedEvent, err);
        }

        return false;
      }
    },

    /**
     * Get dead letter queue (failed deliveries).
     */
    getDeadLetters() {
      return [...deadLetters];
    },

    /**
     * Retry a dead letter event.
     */
    async retryDeadLetter(index: number): Promise<boolean> {
      const item = deadLetters[index];
      if (!item) return false;

      const success = await this.send(item.event);
      if (success) {
        deadLetters.splice(index, 1);
      }
      return success;
    },

    /**
     * Clear dead letter queue.
     */
    clearDeadLetters() {
      deadLetters.length = 0;
    },
  };
}

/**
 * Event type constants for type safety.
 */
export const WEBHOOK_EVENTS = {
  GPU_DEPLOYED: 'gpu.deployed',
  GPU_STOPPED: 'gpu.stopped',
  GPU_TERMINATED: 'gpu.terminated',
  GPU_HEALTH_FAILED: 'gpu.health_failed',
  BUDGET_EXCEEDED: 'budget.exceeded',
  PROVIDER_FAILED: 'provider.failed',
  PIPELINE_COMPLETED: 'pipeline.completed',
  AUTH_SUCCESS: 'auth.success',
  AUTH_FAILURE: 'auth.failure',
  CONFIG_CHANGED: 'config.changed',
} as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS];
