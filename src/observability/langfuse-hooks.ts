/**
 * Langfuse hooks adapter — maps GatewayHooks to Langfuse traces/spans via HTTP.
 * No SDK dependency — uses fetch() directly.
 */

import type { GatewayHooks } from '../hooks';
import type { LangfuseConfig } from './types';

const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';

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
      post('/api/public/ingestion', {
        batch: [{
          id: `trace-${event.timestamp}-${event.userId}`,
          type: 'trace-create',
          timestamp: new Date(event.timestamp).toISOString(),
          body: {
            name: `${event.stage}/${event.provider}`,
            userId: event.userId,
            metadata: { model: event.model, stage: event.stage, provider: event.provider },
          },
        }],
      });
    },

    onRequestEnd: (event) => {
      post('/api/public/ingestion', {
        batch: [{
          id: `span-${event.timestamp}-${event.userId}`,
          type: 'span-create',
          timestamp: new Date(event.timestamp).toISOString(),
          body: {
            name: `${event.stage}/${event.provider}`,
            traceId: `trace-${event.timestamp}-${event.userId}`,
            startTime: new Date(event.timestamp - event.latencyMs).toISOString(),
            endTime: new Date(event.timestamp).toISOString(),
            metadata: {
              model: event.model,
              latencyMs: event.latencyMs,
              success: event.success,
              error: event.error,
            },
          },
        }],
      });
    },

    onFallback: (event) => {
      post('/api/public/ingestion', {
        batch: [{
          id: `event-fallback-${event.timestamp}`,
          type: 'event-create',
          timestamp: new Date(event.timestamp).toISOString(),
          body: {
            name: 'provider-fallback',
            metadata: {
              stage: event.stage,
              from: event.fromProvider,
              to: event.toProvider,
              reason: event.reason,
            },
          },
        }],
      });
    },
  };
}
