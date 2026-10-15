export type PolicyTransport = 'ws' | 'webrtc';
export type SwitchReason = 'loss' | 'stall' | 'clean' | 'unprotected';

export interface TransportPolicyThresholds {
  lossPct: number;
  clearLossPct: number;
  stallMs: number;
  windowTurns: number;
  dwellMs: number;
  maxSwitches: number;
}

export const DEFAULT_POLICY: TransportPolicyThresholds = { lossPct: 2, clearLossPct: 0.5, stallMs: 800, windowTurns: 3, dwellMs: 60_000, maxSwitches: 4 };

export interface NetworkSample {
  at: number;
  lossPct: number | null;
  jitterMs: number | null;
  stallMs: number | null;
  protected: boolean | null;
}

export interface PolicyState {
  on: PolicyTransport;
  bad: number;
  clean: number;
  exposed: number;
  switchedAt: number | null;
  switches: number;
}

export interface PolicyContext {
  spare: boolean;
  fidelity: boolean;
  recovery: boolean;
  thresholds: TransportPolicyThresholds;
}

export interface PolicyEffect {
  type: 'switch';
  to: PolicyTransport;
  reason: SwitchReason;
  lossPct: number | null;
  jitterMs: number | null;
  stallMs: number | null;
}

export const initialPolicy = (on: PolicyTransport): PolicyState => ({ on, bad: 0, clean: 0, exposed: 0, switchedAt: null, switches: 0 });

export const switched = (state: PolicyState, to: PolicyTransport, at: number): PolicyState => ({ on: to, bad: 0, clean: 0, exposed: 0, switchedAt: at, switches: state.switches + 1 });

function reasonToMove(state: PolicyState, stalled: boolean, ctx: PolicyContext): SwitchReason | null {
  const window = ctx.thresholds.windowTurns;
  if (state.on === 'ws') return state.bad >= window && (ctx.recovery || !ctx.fidelity) ? (stalled ? 'stall' : 'loss') : null;
  if (ctx.fidelity && state.exposed >= window) return 'unprotected';
  return state.clean >= window ? 'clean' : null;
}

export function decideTransport(state: PolicyState, sample: NetworkSample, ctx: PolicyContext): { state: PolicyState; effects: PolicyEffect[] } {
  const t = ctx.thresholds;
  const lossy = (sample.lossPct ?? 0) >= t.lossPct;
  const stalled = (sample.stallMs ?? 0) >= t.stallMs;
  const clean = (sample.lossPct ?? 0) <= t.clearLossPct && !stalled;
  const next: PolicyState = {
    ...state,
    bad: lossy || stalled ? state.bad + 1 : 0,
    clean: clean ? state.clean + 1 : 0,
    exposed: state.on === 'webrtc' && lossy && sample.protected === false ? state.exposed + 1 : 0,
  };
  const reason = reasonToMove(next, stalled, ctx);
  const free = ctx.spare && state.switches < t.maxSwitches && (state.switchedAt === null || sample.at - state.switchedAt >= t.dwellMs);
  if (!reason || !free) return { state: next, effects: [] };
  const to: PolicyTransport = state.on === 'ws' ? 'webrtc' : 'ws';
  return { state: switched(state, to, sample.at), effects: [{ type: 'switch', to, reason, lossPct: sample.lossPct, jitterMs: sample.jitterMs, stallMs: sample.stallMs }] };
}
