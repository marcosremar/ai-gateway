/**
 * @ai-gateway/observers — pluggable read-only pipeline observers.
 *
 * Pattern ported from pipecat. Observers attach to the speech pipeline and
 * receive frame-level events without altering the data flow.
 */

export type { FrameKind, PipelineFrame, Observer } from './base';
export { BaseObserver } from './base';

import type { Observer, PipelineFrame } from './base';

const observers = new Set<Observer>();

export function attachObserver(o: Observer): () => void {
  observers.add(o);
  return () => { observers.delete(o); };
}

export function detachObserver(o: Observer): void {
  observers.delete(o);
}

export function getObservers(): Observer[] {
  return Array.from(observers);
}

/** Broadcast a frame to all attached observers. Catches per-observer
 *  exceptions so a single buggy observer can't break the pipeline. */
export function emitFrame(frame: PipelineFrame): void {
  for (const o of observers) {
    try { o.onFrame(frame); }
    catch (err) {
      console.warn(`[observer:${o.name}] threw:`, err instanceof Error ? err.message : err);
    }
  }
}

export { UserBotLatencyObserver } from './user-bot-latency';
export type { LatencyMeasurement, LatencyBreakdown, UserBotLatencyObserverOptions } from './user-bot-latency';

export { DebugLogObserver } from './debug-log';
export type { DebugLogObserverOptions } from './debug-log';

export { TurnTrackingObserver } from './turn-tracker';
export type { TurnEvent, TurnTrackingHandlers } from './turn-tracker';

export { MuteController } from './mute-controller';
export type { MuteStrategy, MuteControllerOptions } from './mute-controller';
