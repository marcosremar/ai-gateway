/**
 * Frame emitter for observability hooks (pipeline stage events).
 *
 * Stub implementation — no-op until a real subscriber is wired in. The shape
 * is preserved so callers in server/ai-handlers.ts can `emitFrame(...)` and
 * downstream consumers can subscribe via `onFrame(...)`.
 */

export interface ObserverFrame {
  kind: string;
  ts: number;
  stage?: string;
  provider?: string;
  meta?: Record<string, unknown>;
}

type FrameSubscriber = (frame: ObserverFrame) => void;
const subscribers = new Set<FrameSubscriber>();

export function emitFrame(frame: ObserverFrame): void {
  for (const sub of subscribers) {
    try { sub(frame); } catch { /* never break the pipeline on observer errors */ }
  }
}

export function onFrame(sub: FrameSubscriber): () => void {
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

export function clearObservers(): void {
  subscribers.clear();
}
