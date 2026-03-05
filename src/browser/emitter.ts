/**
 * Minimal typed event emitter — framework-agnostic, fire-and-forget.
 *
 * Errors thrown by listeners are caught and logged (never break the caller).
 * Follows the same safety pattern as `hooks.ts:emitHook()`.
 */

type Listener<T> = (data: T) => void;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class TypedEmitter<EventMap extends {}> {
  private listeners = new Map<keyof EventMap, Set<Listener<any>>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on<K extends keyof EventMap>(event: K, fn: Listener<EventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(fn);
    return () => this.off(event, fn);
  }

  /**
   * Remove a specific listener.
   */
  off<K extends keyof EventMap>(event: K, fn: Listener<EventMap[K]>): void {
    this.listeners.get(event)?.delete(fn);
  }

  /**
   * Emit an event. Errors in listeners are swallowed (logged to console.warn).
   */
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(data);
      } catch (err) {
        console.warn(`[TypedEmitter] Error in "${String(event)}" listener:`, err);
      }
    }
  }

  /**
   * Remove all listeners (optionally for a specific event).
   */
  removeAllListeners(event?: keyof EventMap): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}
