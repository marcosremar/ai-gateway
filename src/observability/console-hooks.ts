/**
 * Console hooks — structured JSON logging of all gateway events.
 */

import type { GatewayHooks } from '../hooks';
import type { Logger } from '../deps';
import { defaultLogger } from '../logger';

export function createConsoleHooks(logger?: Logger): Partial<GatewayHooks> {
  const log = logger || defaultLogger;

  function emit(hookName: string, data: unknown): void {
    log.log(JSON.stringify({ event: hookName, ...data as object }));
  }

  return {
    onRequestStart: (data) => emit('onRequestStart', data),
    onRequestEnd: (data) => emit('onRequestEnd', data),
    onFallback: (data) => emit('onFallback', data),
    onScaleUp: (data) => emit('onScaleUp', data),
    onScaleDown: (data) => emit('onScaleDown', data),
    onCostAlert: (data) => emit('onCostAlert', data),
    onHealthChange: (data) => emit('onHealthChange', data),
  };
}
