/**
 * mergeHooks — fan-out to multiple GatewayHooks implementations.
 */

import type { GatewayHooks } from '../hooks';

type HookName = keyof GatewayHooks;

const HOOK_NAMES: HookName[] = [
  'onRequestStart', 'onRequestEnd', 'onFallback',
  'onScaleUp', 'onScaleDown', 'onCostAlert', 'onHealthChange', 'onError',
];

/**
 * Merge multiple partial GatewayHooks into one.
 * Each hook fires all implementations (fire-and-forget).
 */
export function mergeHooks(...hookSets: Partial<GatewayHooks>[]): GatewayHooks {
  const merged: GatewayHooks = {};

  for (const name of HOOK_NAMES) {
    const fns = hookSets
      .map((h) => h[name] as ((...args: unknown[]) => void | Promise<void>) | undefined)
      .filter(Boolean) as Array<(...args: unknown[]) => void | Promise<void>>;

    if (fns.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as any)[name] = (...args: unknown[]) => {
        for (const fn of fns) {
          try {
            const result = fn(...args);
            if (result && typeof (result as Promise<void>).catch === 'function') {
              (result as Promise<void>).catch(e => console.warn('[hooks] hook error swallowed:', e instanceof Error ? e.message : e)); // swallow
            }
          } catch (e) { console.warn('[hooks] hook error swallowed:', e instanceof Error ? e.message : e); /* swallow */ }
        }
      };
    }
  }

  return merged;
}
