/**
 * RTT gate for marketplace hosts (Vast): distance ranking (`placements.ts`) is only a prior. The gateway measures the
 * round trip to a host (`DeploymentBackend.measureRtt`, real response bytes only) and releases it as `too-far` when
 * `rtt − baseline` is over `maxRttExcessMs` (or `rtt` over `maxRttMs`, when the spec sets that absolute bound).
 *
 * The baseline is the gateway's own public edge (`RAILWAY_PUBLIC_DOMAIN`, probed in the same tick): it cancels the
 * gateway's own uplink jitter, needs no third-party host (the Scaleway S3 anchor went with Scaleway, 16/10/2026) and
 * makes the excess the path from the gateway's region (Railway europe-west4, Amsterdam; Paris read 9–10 ms from there).
 * Without a baseline the excess is the raw RTT. `DEFAULT_MAX_RTT_EXCESS_MS` = 30 keeps what the old Paris anchor + 20
 * kept (UK and Swiss hosts at 15–18 ms in, the ~60 ms Slovak host of 06/10 out).
 */

export const DEFAULT_MAX_RTT_EXCESS_MS = 30;
export const RTT_ANCHOR_PORT = 80;

export interface RttBaseline { anchor: string; rttMs: number; quietMs?: number }

export const LOADED_BASELINE_MARGIN_MS = 15;

export function baselineLoaded(baseline: RttBaseline | null | undefined): boolean {
  return baseline?.quietMs != null && baseline.rttMs - baseline.quietMs > LOADED_BASELINE_MARGIN_MS;
}
/**
 * How long the gate waits for a first answer after the replica got its address: the front (nginx) is installed by
 * the boot script before anything else, ~1–2 min on a fresh container; no answer in 5 min reads as too far
 * (unreachable is as useless as distant).
 */
export const RTT_GATE_BUDGET_MS = 5 * 60_000;

export type GateStatus = 'pending' | 'passed' | 'adopted';

export interface GateState {
  status: GateStatus;
  /** When the gate first saw the replica with an address. */
  firstSeenAt: number;
  /** Last measured median (ms), null while none. */
  rttMs: number | null;
  baseline?: RttBaseline | null;
}

export type GateDecision = 'pass' | 'too-far' | 'wait';

export interface GateInput {
  rttMs: number | null;
  /** The spec's `maxRttMs`: an absolute upper bound on top of the excess rule. */
  maxRttMs?: number;
  baselineMs?: number | null;
  maxExcessMs?: number;
  firstSeenAt: number;
  now: number;
}

/** Pure decision for one measurement. `rttMs` null = no sample this time. */
export function gateDecision(input: GateInput): GateDecision {
  if (input.rttMs == null) return input.now - input.firstSeenAt >= RTT_GATE_BUDGET_MS ? 'too-far' : 'wait';
  const near = input.rttMs - (input.baselineMs ?? 0) <= (input.maxExcessMs ?? DEFAULT_MAX_RTT_EXCESS_MS);
  return near && (input.maxRttMs === undefined || input.rttMs <= input.maxRttMs) ? 'pass' : 'too-far';
}

export function gateNote(input: GateInput & { anchor?: string }): string {
  const maxExcess = input.maxExcessMs ?? DEFAULT_MAX_RTT_EXCESS_MS;
  if (input.rttMs == null) return `no RTT answer > maxRttExcessMs ${maxExcess}`;
  const excess = Math.round(input.rttMs - (input.baselineMs ?? 0));
  const bound = input.maxRttMs === undefined ? '' : `, maxRttMs ${input.maxRttMs}`;
  const base = input.baselineMs == null ? 'no baseline' : `baseline ${input.baselineMs} ms (${input.anchor ?? 'anchor'})`;
  return `RTT ${input.rttMs} ms, ${base}: `
    + `${excess >= 0 ? '+' : '−'}${Math.abs(excess)} ms ${excess <= maxExcess ? '≤' : '>'} maxRttExcessMs ${maxExcess}${bound}`;
}
