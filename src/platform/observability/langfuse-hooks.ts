/**
 * Langfuse hooks adapter — maps GatewayHooks to Langfuse traces/spans via HTTP.
 * No SDK dependency — uses fetch() directly.
 * Automatically redacts sensitive fields before sending to Langfuse.
 */

import type { GatewayHooks } from '../../hooks';
import type { LangfuseConfig } from './types';

const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';

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

function redactEvent(event: unknown): unknown {
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
  return safe;
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
      post('/api/public/ingestion', {
        batch: [{
          id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          type: 'trace-create',
          timestamp: new Date(safeEvent.timestamp as number).toISOString(),
          body: {
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
      post('/api/public/ingestion', {
        batch: [{
          id: `span-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          type: 'span-create',
          timestamp: new Date(safeEvent.timestamp as number).toISOString(),
          body: {
            name: `${safeEvent.stage}/${safeEvent.provider}`,
            traceId: `trace-${safeEvent.timestamp}-redacted`,
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
