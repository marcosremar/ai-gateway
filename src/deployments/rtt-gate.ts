/**
 * RTT gate for marketplace hosts (Vast): distance ranking (`placements.ts`) is only a prior — the owner, in France,
 * saw ~60 ms to a Slovak host. So once a freshly rented replica has an address, the gateway measures the round trip
 * to its nginx front (`DeploymentBackend.measureRtt`: application-level, real response bytes only, median of a few
 * samples) and releases it as `too-far` when the median is above `maxRttMs`; the backend then avoids that host and
 * the next create picks the next offer. A replica that passed is never measured again.
 *
 * The gate is relative: in the same tick the gateway probes a fixed anchor in the users' country (`RTT_ANCHORS`) and
 * compares `rtt − baseline` with `maxRttExcessMs`, so the verdict does not depend on where the gateway itself runs
 * (live 2026-10-08: from a Mac in France a French host measured 42 ms while Paris measured 45 — the absolute 35 ms
 * released it). `DEFAULT_MAX_RTT_EXCESS_MS` = 20: UK hosts measured 12–15 ms over Paris that day and served the class
 * as fast as an L40S, so they stay in with ~5 ms of noise margin, while the ~60 ms Slovak host (≥ 40 ms over) goes.
 * The difference is a lower bound of the anchor → host round trip, not the user's own: `maxRttMs`, when the spec sets
 * it, stays an absolute upper bound on top. Without a baseline (no anchor for the country, or its probe failed) the
 * gate is the absolute rule: `maxRttMs`, default `DEFAULT_MAX_RTT_MS` = 35 from the gateway on Railway europe-west4
 * (NL), where France → host is typically 10–20 ms more.
 */

/** `maxRttMs` of the absolute rule when the spec sets none, measured from the gateway (NL). */
export const DEFAULT_MAX_RTT_MS = 35;
export const DEFAULT_MAX_RTT_EXCESS_MS = 20;
export const RTT_ANCHORS: Readonly<Record<string, string>> = {
  FR: 's3.fr-par.scw.cloud', NL: 's3.nl-ams.scw.cloud', PL: 's3.pl-waw.scw.cloud',
};
export const RTT_ANCHOR_PORT = 80;

export interface RttBaseline { anchor: string; rttMs: number }
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
  /** The spec's `maxRttMs`: the whole rule without a baseline, an upper bound with one. */
  maxRttMs?: number;
  baselineMs?: number | null;
  maxExcessMs?: number;
  firstSeenAt: number;
  now: number;
}

/** Pure decision for one measurement. `rttMs` null = no sample this time. */
export function gateDecision(input: GateInput): GateDecision {
  if (input.rttMs == null) return input.now - input.firstSeenAt >= RTT_GATE_BUDGET_MS ? 'too-far' : 'wait';
  if (input.baselineMs == null) return input.rttMs <= (input.maxRttMs ?? DEFAULT_MAX_RTT_MS) ? 'pass' : 'too-far';
  const near = input.rttMs - input.baselineMs <= (input.maxExcessMs ?? DEFAULT_MAX_RTT_EXCESS_MS);
  return near && (input.maxRttMs === undefined || input.rttMs <= input.maxRttMs) ? 'pass' : 'too-far';
}

export function gateNote(input: GateInput & { anchor?: string }): string {
  const pass = gateDecision(input) === 'pass';
  if (input.rttMs == null || input.baselineMs == null) {
    const max = input.maxRttMs ?? DEFAULT_MAX_RTT_MS;
    return `${input.rttMs != null ? `RTT ${input.rttMs} ms` : 'no RTT answer'} ${pass ? '≤' : '>'} maxRttMs ${max}`;
  }
  const excess = Math.round(input.rttMs - input.baselineMs);
  const maxExcess = input.maxExcessMs ?? DEFAULT_MAX_RTT_EXCESS_MS;
  const bound = input.maxRttMs === undefined ? '' : `, maxRttMs ${input.maxRttMs}`;
  return `RTT ${input.rttMs} ms, baseline ${input.baselineMs} ms (${input.anchor ?? 'anchor'}): `
    + `${excess >= 0 ? '+' : '−'}${Math.abs(excess)} ms ${excess <= maxExcess ? '≤' : '>'} maxRttExcessMs ${maxExcess}${bound}`;
}
