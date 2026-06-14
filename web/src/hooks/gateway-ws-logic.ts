/**
 * gateway-ws-logic.ts — framework-free types + pure reducers for the gateway
 * WebSocket. Kept free of any React import so it is unit-testable without a DOM.
 *
 * Fix #942: a single shared WebSocket is multiplexed across components; this
 * module holds the pure URL resolution and event-reduction logic the singleton
 * manager (in `useGatewayWs.ts`) builds on.
 */

export interface GpuStatusEvent {
  type: 'gpu:status';
  gpuStatus: 'ready' | 'offline' | 'booting' | 'error';
  tier: 'gpu' | 'cloud';
  reason: string;
  endpoint: string | null;
  gpuType: string | null;
  modelWarmth: { stt: boolean; llm: boolean; tts: boolean };
  pipelineRouting: { stt: string; llm: string; tts: string; mode: string } | null;
  readiness: { phase: string; shadowRuns: number };
}

export interface GpuReadinessEvent {
  type: 'gpu:readiness';
  stage: 'stt' | 'llm' | 'tts' | 'all';
  phase: string;
  run?: number;
  totalRuns?: number;
  latencyMs?: number;
  bestLatencyMs?: number;
  targetMs?: number;
  passed?: boolean;
  runsUsed?: number;
  shadowCompletedRuns?: number;
  shadowTotalRuns?: number;
  attempts?: number;
  maxAttempts?: number;
  retryInMs?: number;
  error?: string;
}

export type GatewayWsEvent =
  | GpuStatusEvent
  | GpuReadinessEvent
  | { type: string;[k: string]: unknown };

export interface GatewayWsState {
  connected: boolean;
  lastEvent: GatewayWsEvent | null;
  gpuStatus: GpuStatusEvent | null;
  readinessPhase: string;
  /** Ordered list of phase transitions with timestamps */
  transitions: Array<{ phase: string; stage: string; ts: number; detail?: string }>;
  /** Current benchmark progress per stage */
  benchmarkProgress: Record<string, { run: number; totalRuns: number; bestMs: number | null; targetMs: number; passed?: boolean }>;
  /** Shadow mode progress */
  shadowProgress: { completed: number; total: number } | null;
}

export const INITIAL_WS_STATE: GatewayWsState = {
  connected: false,
  lastEvent: null,
  gpuStatus: null,
  readinessPhase: 'idle',
  transitions: [],
  benchmarkProgress: {},
  shadowProgress: null,
};

/**
 * Resolve the gateway WebSocket URL for the current page, or `null` when WS is
 * unavailable (HTTPS production — Fly.io only exposes one port). Pure.
 */
export function resolveGatewayWsUrl(loc: {
  hostname: string;
  protocol: string;
  port: string;
}): string | null {
  const isSecure = loc.protocol === 'https:';
  // Skip WS on HTTPS production (Fly.io only exposes one port).
  if (isSecure) return null;
  // In dev mode (Next.js on 3000), connect to gateway WS on 4001.
  const locationPort = parseInt(loc.port || '443', 10);
  const port = locationPort === 3000 ? 4001 : locationPort + 1;
  return `ws://${loc.hostname}:${port}/`;
}

/**
 * Reduce a single incoming event into the next state. Pure.
 */
export function reduceGatewayWsEvent(s: GatewayWsState, msg: GatewayWsEvent): GatewayWsState {
  const next: GatewayWsState = { ...s, lastEvent: msg };

  if (msg.type === 'gpu:status') {
    const evt = msg as GpuStatusEvent;
    next.gpuStatus = evt;
    next.readinessPhase = evt.readiness?.phase || 'idle';
    next.transitions = [...s.transitions, {
      phase: evt.readiness?.phase || evt.gpuStatus,
      stage: 'all',
      ts: Date.now(),
      detail: evt.reason,
    }].slice(-50);
  }

  if (msg.type === 'gpu:readiness') {
    const evt = msg as GpuReadinessEvent;
    next.readinessPhase = evt.phase;

    const lastTransition = s.transitions[s.transitions.length - 1];
    if (!lastTransition || lastTransition.phase !== evt.phase || lastTransition.stage !== evt.stage) {
      next.transitions = [...s.transitions, {
        phase: evt.phase,
        stage: evt.stage,
        ts: Date.now(),
        detail: evt.error || (evt.passed != null ? (evt.passed ? 'passed' : 'failed') : undefined),
      }].slice(-50);
    }

    if (evt.phase === 'benchmarking' && evt.run != null && evt.stage !== 'all') {
      next.benchmarkProgress = {
        ...s.benchmarkProgress,
        [evt.stage]: {
          run: evt.run,
          totalRuns: evt.totalRuns || 0,
          bestMs: evt.bestLatencyMs ?? null,
          targetMs: evt.targetMs || 0,
          passed: evt.passed,
        },
      };
    }

    if ((evt.phase === 'ready' || evt.phase === 'failed') && evt.stage !== 'all') {
      next.benchmarkProgress = {
        ...s.benchmarkProgress,
        [evt.stage]: {
          run: evt.runsUsed || 0,
          totalRuns: evt.runsUsed || 0,
          bestMs: evt.bestLatencyMs ?? null,
          targetMs: evt.targetMs || 0,
          passed: evt.passed,
        },
      };
    }

    if (evt.phase === 'shadow') {
      next.shadowProgress = {
        completed: evt.shadowCompletedRuns ?? 0,
        total: evt.shadowTotalRuns ?? 5,
      };
    }

    if (evt.phase === 'condemned' || evt.phase === 'auto-recovery') {
      next.shadowProgress = null;
    }
  }

  return next;
}
