// ── Dynamic Tier Ranking by Observed P50 Latency (cold-start plan A2) ────────
//
// The tier cascade (`buildGpuTiers`) is statically ordered by cost/heuristic.
// When one provider consistently takes 30% longer to reach "ready" than
// another, we should reorder the cascade at runtime so the faster provider
// is tried first. This module tracks per-provider EWMA of total cold-start
// time (pullMs + bootMs + modelLoadMs) and exposes a `reorderByLatency`
// helper that sorts a given tier list by observed P50.
//
// Scope guardrails (matches the plan doc):
//   - P50 is the primary signal.
//   - Cost is the tiebreaker when two providers are within 10% of each other
//     on P50 — we do NOT ignore cost, we just demote it below latency.
//   - The 7-day window ensures stale data (e.g. a provider that was slow
//     last month but recovered) doesn't pin the cascade forever.
//   - Cooldown (ADR-009) is NOT touched here — a provider in cooldown is
//     removed upstream; this module only reorders the survivors.
//
// Persistence: mirrors ADR-009 (cooldowns). Atomic tmp+rename, load on
// startup, debounced 10s write on every observation.

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'fs';
import { createLogger } from '../src/logger';
import type { ProviderName, GpuTier } from '../src/gpu-providers/deploy-orchestrator';

const log = createLogger('tier-ranking');

const BABELCAST_DIR = join(homedir(), '.babelcast');
const RANKING_FILE = join(BABELCAST_DIR, 'tier-ranking.json');
const WRITE_DEBOUNCE_MS = 10_000;

// 7-day observation window — older samples are pruned on load + on each record.
const WINDOW_MS = 7 * 24 * 60 * 60_000;

// EWMA smoothing factor. alpha=0.3 weights recent samples heavily enough to
// react to regressions within ~3 deploys while still resisting single-spike
// noise. Matches the pattern in `src/autoscaler/latency-tracker.ts`.
const EWMA_ALPHA = 0.3;

// Tiebreaker: two providers within this fraction of each other on P50 are
// treated as equivalent; cost becomes the deciding factor.
const P50_TIE_THRESHOLD = 0.10;

/** Rough per-provider cost priors used ONLY as a tiebreaker when P50 is a wash.
 *  (Exact hourly prices depend on GPU type and region — these are order-of-
 *  magnitude hints for `reorderByLatency` when we have no better signal.) */
const PROVIDER_COST_PRIOR: Record<ProviderName, number> = {
  vast: 0.35,        // Vast.ai spot — cheapest
  'vast-vm': 0.40,   // Vast.ai VM mode
  runpod: 0.45,      // RunPod spot
  tensordock: 0.55,  // TensorDock
  snapgpu: 0.50,     // Snapgpu wraps another provider
  modal: 2.50,       // Modal on-demand is expensive
  hyperstack: 0.75,  // Hyperstack on-demand
};

export interface ProviderLatencyObservation {
  totalMs: number;       // pull + boot + model-load
  recordedAt: number;    // epoch ms
  pullMs?: number;       // optional breakdown
  bootMs?: number;
  modelLoadMs?: number;
}

interface RankingEntry {
  ewmaMs: number;              // EWMA of totalMs
  p50Ms: number;               // P50 over observations[]
  count: number;
  lastRecordedAt: number;
  observations: ProviderLatencyObservation[]; // last 7 days of samples
}

type RankingMap = Partial<Record<ProviderName, RankingEntry>>;

let _ranking: RankingMap = {};
let _writeTimer: ReturnType<typeof setTimeout> | null = null;

// ── Internal helpers ────────────────────────────────────────────────────────

function pruneOldObservations(entry: RankingEntry, now: number): void {
  const cutoff = now - WINDOW_MS;
  entry.observations = entry.observations.filter((o) => o.recordedAt >= cutoff);
  entry.count = entry.observations.length;
}

function computeP50(observations: ProviderLatencyObservation[]): number {
  if (observations.length === 0) return 0;
  const sorted = observations.map((o) => o.totalMs).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function schedulePersist(): void {
  if (_writeTimer) return;
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    saveRankingNow();
  }, WRITE_DEBOUNCE_MS);
  if (typeof (_writeTimer as unknown as { unref?: () => void }).unref === 'function') {
    (_writeTimer as unknown as { unref: () => void }).unref();
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record a successful deploy's total cold-start time for a provider.
 * Updates EWMA and P50 and schedules a debounced persist.
 */
export function recordTierLatency(
  provider: ProviderName,
  sample: ProviderLatencyObservation,
): void {
  const now = sample.recordedAt || Date.now();
  const entry = _ranking[provider] ?? {
    ewmaMs: sample.totalMs,
    p50Ms: sample.totalMs,
    count: 0,
    lastRecordedAt: now,
    observations: [],
  };
  entry.observations.push({ ...sample, recordedAt: now });
  pruneOldObservations(entry, now);
  entry.p50Ms = computeP50(entry.observations);
  entry.ewmaMs = entry.count === 0
    ? sample.totalMs
    : EWMA_ALPHA * sample.totalMs + (1 - EWMA_ALPHA) * entry.ewmaMs;
  entry.lastRecordedAt = now;
  entry.count = entry.observations.length;
  _ranking[provider] = entry;
  log.log(
    `[tier-ranking] ${provider} +1 sample (total=${Math.round(sample.totalMs)}ms) — ` +
    `EWMA=${Math.round(entry.ewmaMs)}ms P50=${Math.round(entry.p50Ms)}ms n=${entry.count}`,
  );
  schedulePersist();
}

/**
 * Return the current ranking snapshot for a provider, or null if no data.
 * Used by the settings UI and tests.
 */
export function getTierRanking(provider: ProviderName): RankingEntry | null {
  return _ranking[provider] ?? null;
}

/**
 * Return a frozen map of all current rankings (for observability).
 */
export function getAllTierRankings(): Readonly<RankingMap> {
  return _ranking;
}

/**
 * Whether Modal has the highest (most-deprioritizing) cost prior, so a P50 tie
 * with any other provider keeps Modal last (#135).
 *
 * The cascade comment in `gpu-deploy-with-tiers.ts` says "Modal must not jump
 * ahead"; the latency reorder is intentional, but Modal's on-demand pricing
 * (2.50 prior) must dominate the cost tiebreaker so it never wins a near-tie.
 * Pure — used by tests to lock the invariant.
 */
export function modalIsCostDeprioritized(
  priors: Record<ProviderName, number> = PROVIDER_COST_PRIOR,
): boolean {
  const modal = priors.modal;
  return Object.entries(priors).every(([name, cost]) => name === 'modal' || cost <= modal);
}

/**
 * Reorder a tier list by observed P50 cold-start latency (ascending).
 *
 * Rules:
 *   - Providers with observations: sorted by P50.
 *   - Ties within `P50_TIE_THRESHOLD` (±10%): cost prior breaks the tie
 *     (cheaper wins).
 *   - Providers with no observations: appended at the end in their original
 *     relative order (so we still probe new providers, just not first).
 *   - Cooldown is NOT consulted here — upstream filters already did that.
 *
 * @param tiers The cascade produced by `buildGpuTiers`.
 * @returns A new array (input is not mutated).
 */
export function reorderByLatency(tiers: GpuTier[]): GpuTier[] {
  if (tiers.length <= 1) return [...tiers];
  const observed: GpuTier[] = [];
  const unobserved: GpuTier[] = [];
  for (const t of tiers) {
    if (_ranking[t.name]?.count && _ranking[t.name]!.count > 0) observed.push(t);
    else unobserved.push(t);
  }
  observed.sort((a, b) => {
    const pA = _ranking[a.name]!.p50Ms;
    const pB = _ranking[b.name]!.p50Ms;
    const diff = Math.abs(pA - pB) / Math.max(pA, pB, 1);
    if (diff < P50_TIE_THRESHOLD) {
      // Latency effectively tied — cost tiebreaker.
      const cA = PROVIDER_COST_PRIOR[a.name] ?? 1;
      const cB = PROVIDER_COST_PRIOR[b.name] ?? 1;
      return cA - cB;
    }
    return pA - pB;
  });
  return [...observed, ...unobserved];
}

// ── Persistence (mirrors cooldown-persistence.ts pattern) ────────────────────

interface PersistedRanking {
  ranking: RankingMap;
  savedAt: number;
}

export function loadTierRanking(): void {
  try {
    if (!existsSync(RANKING_FILE)) return;
    const raw = readFileSync(RANKING_FILE, 'utf-8');
    const data = JSON.parse(raw) as PersistedRanking;
    if (!data || typeof data !== 'object' || !data.ranking) return;
    const now = Date.now();
    const loaded: RankingMap = {};
    for (const [name, entry] of Object.entries(data.ranking)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as RankingEntry;
      const obs = Array.isArray(e.observations) ? e.observations : [];
      const pruned = obs.filter((o) =>
        typeof o?.totalMs === 'number'
        && typeof o?.recordedAt === 'number'
        && o.recordedAt >= now - WINDOW_MS,
      );
      if (pruned.length === 0) continue;
      loaded[name as ProviderName] = {
        ewmaMs: typeof e.ewmaMs === 'number' ? e.ewmaMs : computeP50(pruned),
        p50Ms: computeP50(pruned),
        count: pruned.length,
        lastRecordedAt: e.lastRecordedAt || now,
        observations: pruned,
      };
    }
    _ranking = loaded;
    const nonEmpty = Object.keys(_ranking).length;
    if (nonEmpty > 0) {
      log.log(`Loaded ${nonEmpty} provider ranking(s) from ${RANKING_FILE}`);
    }
  } catch (err) {
    log.warn('Failed to load tier ranking:', err instanceof Error ? err.message : err);
  }
}

export function saveRankingNow(): void {
  try {
    if (Object.keys(_ranking).length === 0) return;
    mkdirSync(BABELCAST_DIR, { recursive: true });
    const data: PersistedRanking = { ranking: _ranking, savedAt: Date.now() };
    const tmp = RANKING_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, RANKING_FILE);
    log.log(`Saved tier ranking (${Object.keys(_ranking).length} providers) to ${RANKING_FILE}`);
  } catch (err) {
    log.warn('Failed to save tier ranking:', err instanceof Error ? err.message : err);
  }
}

/** Test helper — wipes all rankings. Not exported in production API. */
export function __resetTierRankingForTests(): void {
  _ranking = {};
  if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
}

export const __testing = {
  RANKING_FILE,
  WINDOW_MS,
  EWMA_ALPHA,
  P50_TIE_THRESHOLD,
};
