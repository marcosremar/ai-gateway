/**
 * Console hooks — structured JSON logging of all gateway events.
 * Automatically redacts sensitive fields before logging.
 */

import type { GatewayHooks } from '../../hooks';
import type { Logger } from '../deps';
import { defaultLogger } from '../logger';

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

export function createConsoleHooks(logger?: Logger): Partial<GatewayHooks> {
  const log = logger || defaultLogger;

  function emit(hookName: string, data: unknown): void {
    log.log(JSON.stringify({ event: hookName, ...redactObject(data) as object }));
  }

  return {
    onRequestStart: (data) => emit('onRequestStart', data),
    onRequestEnd: (data) => emit('onRequestEnd', data),
    onFallback: (data) => emit('onFallback', data),
    onScaleUp: (data) => emit('onScaleUp', data),
    onScaleDown: (data) => emit('onScaleDown', data),
    onCostAlert: (data) => emit('onCostAlert', data),
    onHealthChange: (data) => emit('onHealthChange', data),
    onError: (data) => log.warn(JSON.stringify({ event: 'onError', ...redactObject(data) as object })),
  };
}
