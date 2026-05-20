// ── Observers initialization ────────────────────────────────────────────────
// Boot-time setup: attach UserBotLatencyObserver + TurnTrackingObserver and
// store recent records in ring buffers so admin UI can pull them.

import {
  attachObserver,
  detachObserver,
  UserBotLatencyObserver,
  TurnTrackingObserver,
  MuteController,
  type LatencyBreakdown,
  type MuteStrategy,
} from '../src/observers';
import { createLogger } from '../src/logger';

const log = createLogger('observers');

const RECENT_CAP = 100;
const recent: Array<LatencyBreakdown & { ts: number }> = [];

interface TurnRecord {
  turnId: number;
  startedAt: number;
  endedAt: number | null;
  side: 'user' | 'bot';
  provider?: string;
  transcript?: string;
  audioBytes?: number;
}
const recentTurns: TurnRecord[] = [];
const TURNS_CAP = 200;

let initialized = false;
let muteController: MuteController | null = null;

export function initObservers(): void {
  if (initialized) return;
  initialized = true;

  // Mute controller — server-side gate that drops user audio while bot is
  // speaking. Strategy via env: AIGW_MUTE_STRATEGY = always_mute_during_bot_speech
  // (default — best for speakers/feedback prevention) | mute_until_first_word | never.
  const initialStrategy = (process.env.AIGW_MUTE_STRATEGY as MuteStrategy) || 'always_mute_during_bot_speech';
  currentStrategy = initialStrategy;
  muteController = new MuteController({ strategy: initialStrategy });
  attachObserver(muteController);

  attachObserver(new UserBotLatencyObserver({
    onLatencyMeasured: (m) => {
      log.log(`[turn-latency] ${m.totalMs}ms`);
    },
    onLatencyBreakdown: (b) => {
      recent.push({ ...b, ts: Date.now() });
      if (recent.length > RECENT_CAP) recent.shift();
    },
  }));

  attachObserver(new TurnTrackingObserver({
    onUserTurnStarted: (e) => {
      recentTurns.push({ turnId: e.turnId, startedAt: e.ts, endedAt: null, side: 'user', provider: e.provider });
      while (recentTurns.length > TURNS_CAP) recentTurns.shift();
    },
    onUserTurnEnded: (e) => {
      const last = [...recentTurns].reverse().find(t => t.turnId === e.turnId && t.side === 'user');
      if (last) { last.endedAt = e.ts; last.transcript = e.transcript; }
    },
    onBotTurnStarted: (e) => {
      recentTurns.push({ turnId: e.turnId, startedAt: e.ts, endedAt: null, side: 'bot', provider: e.provider });
      while (recentTurns.length > TURNS_CAP) recentTurns.shift();
    },
    onBotTurnEnded: (e) => {
      const last = [...recentTurns].reverse().find(t => t.turnId === e.turnId && t.side === 'bot');
      if (last) { last.endedAt = e.ts; last.audioBytes = e.audioBytes; }
    },
  }));

  log.log(`[observers] UserBotLatency + TurnTracking attached (latency-ring=${RECENT_CAP}, turns-ring=${TURNS_CAP})`);
}

export function getRecentTurnLatencies(): Array<LatencyBreakdown & { ts: number }> {
  return [...recent];
}

export function clearTurnLatencies(): void {
  recent.length = 0;
}

export function getRecentTurns(): TurnRecord[] {
  return [...recentTurns];
}

export function clearRecentTurns(): void {
  recentTurns.length = 0;
}

/** Should the server drop the next chunk of user audio? Returns false when
 *  observers haven't been initialized (legitimate — pre-startup paths). */
export function shouldDropUserAudio(): boolean {
  return muteController?.shouldDropUserAudio() ?? false;
}

// ── Frame inspector — broadcasts every emitted frame to subscribed WS
// clients (Whisker-style live debug). Init lazily on first subscriber.

import { attachObserver as _attachObs, BaseObserver, type PipelineFrame } from '../src/observers';

const frameSubscribers = new Set<(frame: PipelineFrame) => void>();

let inspectorAttached = false;
function ensureInspectorObserver(): void {
  if (inspectorAttached) return;
  inspectorAttached = true;
  class FrameInspector extends BaseObserver {
    readonly name = 'frame-inspector';
    onFrame(frame: PipelineFrame): void {
      for (const s of frameSubscribers) {
        try { s(frame); } catch { /* subscribers must not throw */ }
      }
    }
  }
  _attachObs(new FrameInspector());
}

export function subscribeFrames(handler: (frame: PipelineFrame) => void): () => void {
  ensureInspectorObserver();
  frameSubscribers.add(handler);
  return () => { frameSubscribers.delete(handler); };
}

export function frameSubscriberCount(): number {
  return frameSubscribers.size;
}

let currentStrategy: MuteStrategy = 'always_mute_during_bot_speech';

export function getMuteState(): { muted: boolean; strategy: MuteStrategy | null } {
  return {
    muted: muteController?.isMuted() ?? false,
    strategy: muteController ? currentStrategy : null,
  };
}

const VALID_STRATEGIES: MuteStrategy[] = ['always_mute_during_bot_speech', 'mute_until_first_word', 'never'];

export function setMuteStrategy(strategy: MuteStrategy): { ok: boolean; strategy: MuteStrategy; error?: string } {
  if (!VALID_STRATEGIES.includes(strategy)) {
    return { ok: false, strategy: currentStrategy, error: `Invalid strategy. Expected one of: ${VALID_STRATEGIES.join(', ')}` };
  }
  if (!muteController) {
    return { ok: false, strategy: currentStrategy, error: 'MuteController not initialized — call initObservers() first' };
  }
  // Detach old, attach new (MuteController has internal state we can't mutate).
  detachObserver(muteController);
  muteController = new MuteController({ strategy });
  attachObserver(muteController);
  currentStrategy = strategy;
  log.log(`[mute] strategy → ${strategy}`);
  return { ok: true, strategy };
}
