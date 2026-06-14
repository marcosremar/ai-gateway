/**
 * polling.ts — pure helpers for tab-visibility-aware polling.
 *
 * Fixes: #940 (pause polling loops when the tab is hidden), #952 (slow down
 * background polling instead of hammering the gateway).
 *
 * These functions are intentionally framework-free and side-effect-free so they
 * can be unit-tested without a DOM. The React hook (`usePolling`) wires them to
 * `document.hidden` + `visibilitychange`.
 */

'use client';

import { useEffect, useRef } from 'react';
import { shouldPoll } from './polling-logic';

export { shouldPoll, effectivePollInterval } from './polling-logic';

/** True when running in a browser with the Page Visibility API available. */
function canObserveVisibility(): boolean {
  return typeof document !== 'undefined' && typeof document.hidden === 'boolean';
}

/**
 * usePolling — run `callback` immediately, then on an interval that pauses while
 * the tab is hidden and resumes (with an immediate refresh) when it becomes
 * visible again.
 *
 * Replaces the bespoke `setInterval` blocks copied across the data hooks so that
 * a single, visibility-aware implementation governs all background polling.
 */
export function usePolling(
  callback: () => void,
  intervalMs: number,
  active = true,
): void {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    if (!active) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (shouldPoll(canObserveVisibility() ? document.hidden : false)) {
        savedCallback.current();
      }
    };

    const start = () => {
      if (timer == null) timer = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = () => {
      if (canObserveVisibility() && document.hidden) {
        // Tab went to the background — pause the loop to save requests.
        stop();
      } else {
        // Tab came back — refresh immediately, then resume the loop.
        savedCallback.current();
        start();
      }
    };

    // Initial fetch + start loop (only if visible).
    if (!canObserveVisibility() || !document.hidden) {
      savedCallback.current();
      start();
    }

    if (canObserveVisibility()) {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      stop();
      if (canObserveVisibility()) {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [intervalMs, active]);
}
