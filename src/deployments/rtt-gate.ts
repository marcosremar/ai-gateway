/**
 * RTT gate for marketplace hosts (Vast): distance ranking (`placements.ts`) is only a prior — the owner, in France,
 * saw ~60 ms to a Slovak host. So once a freshly rented replica has an address, the gateway measures the round trip
 * to its nginx front (`DeploymentBackend.measureRtt`: application-level, real response bytes only, median of a few
 * samples) and releases it as `too-far` when the median is above `maxRttMs`; the backend then avoids that host and
 * the next create picks the next offer. A replica that passed is never measured again.
 *
 * Vantage point: the gateway runs on Railway europe-west4 (Netherlands), so this is NL → host, not user → host.
 * France → host is typically 10–20 ms more; `DEFAULT_MAX_RTT_MS` = 35 from NL keeps a French user near ~50 ms.
 */

/** Default `maxRttMs`, measured from the gateway (NL). See the module comment for the France budget it implies. */
export const DEFAULT_MAX_RTT_MS = 35;
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
}

export type GateDecision = 'pass' | 'too-far' | 'wait';

/** Pure decision for one measurement. `rttMs` null = no sample this time. */
export function gateDecision(input: { rttMs: number | null; maxRttMs: number; firstSeenAt: number; now: number }): GateDecision {
  if (input.rttMs != null) return input.rttMs <= input.maxRttMs ? 'pass' : 'too-far';
  return input.now - input.firstSeenAt >= RTT_GATE_BUDGET_MS ? 'too-far' : 'wait';
}
