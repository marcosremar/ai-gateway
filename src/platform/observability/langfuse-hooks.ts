/**
 * Langfuse hooks adapter — maps GatewayHooks to Langfuse traces/spans via HTTP.
 * No SDK dependency — uses fetch() directly.
 * Automatically redacts sensitive fields before sending to Langfuse.
 */

import { createHash } from 'crypto';
import type { GatewayHooks } from '../../hooks';
import type { LangfuseConfig } from './types';

const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';

/**
 * #600: derive a STABLE Langfuse trace id from the fields shared by both
 * `RequestStartEvent` and `RequestEndEvent` (userId/stage/provider). Previously
 * `onRequestStart` used `trace-${Date.now()}-${random}` while `onRequestEnd`
 * used `trace-${timestamp}-redacted`; those never matched, so spans never
 * attached to their trace. Using the same derivation in both handlers links the
 * span to its trace. (The events carry no requestId; the shared-identity tuple
 * is the best stable correlation key available without a cross-module change.)
 */
export function langfuseTraceId(event: {
  userId?: unknown;
  stage?: unknown;
  provider?: unknown;
}): string {
  const key = `${String(event.userId ?? 'anon')}|${String(event.stage ?? '')}|${String(event.provider ?? '')}`;
  return 'trace-' + createHash('sha256').update(key).digest('hex').slice(0, 24);
}

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

function redactEvent<T extends object>(event: T): T {
  if (!event || typeof event !== 'object') return event;
  const e = event as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e)) {
    if (isSensitiveKey(key)) {
      safe[key] = '[redacted]';
    } else {
      safe[key] = value;
    }
  }
  return safe as T;
}

export function createLangfuseHooks(config: LangfuseConfig): Partial<GatewayHooks> {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const authHeader = 'Basic ' + Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64');

  async function post(path: string, body: unknown): Promise<void> {
    try {
      await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify(body),
      });
    } catch { /* fire-and-forget */ }
  }

  return {
    onRequestStart: (event) => {
      const safeEvent = redactEvent(event);
      const traceId = langfuseTraceId(safeEvent as unknown as Record<string, unknown>);
      post('/api/public/ingestion', {
        batch: [{
          id: `event-trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          type: 'trace-create',
          timestamp: new Date(safeEvent.timestamp as number).toISOString(),
          body: {
            id: traceId,
            name: `${safeEvent.stage}/${safeEvent.provider}`,
            userId: safeEvent.userId ? '[redacted]' : undefined,
            metadata: {
              model: safeEvent.model,
              stage: safeEvent.stage,
              provider: safeEvent.provider,
            },
          },
        }],
      });
    },

    onRequestEnd: (event) => {
      const safeEvent = redactEvent(event);
      const traceId = langfuseTraceId(safeEvent as unknown as Record<string, unknown>);
      post('/api/public/ingestion', {
        batch: [{
          id: `span-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          type: 'span-create',
          timestamp: new Date(safeEvent.timestamp as number).toISOString(),
          body: {
            name: `${safeEvent.stage}/${safeEvent.provider}`,
            traceId,
            startTime: new Date((safeEvent.timestamp as number) - (safeEvent.latencyMs as number || 0)).toISOString(),
            endTime: new Date(safeEvent.timestamp as number).toISOString(),
            metadata: {
              model: safeEvent.model,
              latencyMs: safeEvent.latencyMs,
              success: safeEvent.success,
              error: safeEvent.error ? '[redacted]' : undefined,
            },
          },
        }],
      });
    },

    onFallback: (event) => {
      const safeEvent = redactEvent(event);
      post('/api/public/ingestion', {
        batch: [{
          id: `event-fallback-${Date.now()}`,
          type: 'event-create',
          timestamp: new Date(safeEvent.timestamp as number).toISOString(),
          body: {
            name: 'provider-fallback',
            metadata: {
              stage: safeEvent.stage,
              from: safeEvent.fromProvider,
              to: safeEvent.toProvider,
              reason: safeEvent.reason,
            },
          },
        }],
      });
    },
  };
}
