import { emitGatewayEvent } from '../../telemetry/emit';

export const REORDER = {
  minSamples: 20,
  windowMs: 15 * 60_000,
  samplesKept: 200,
  slowerFactor: 1.5,
  promoteFailRate: 0.2,
  healthyFailRate: 0.05,
  revertSlack: 1.1,
  minDwellMs: 5 * 60_000,
  maxDwellMs: 30 * 60_000,
} as const;

export interface Reorderable { providerId: string; model?: string; group?: string; chainKey?: string }

interface Sample { at: number; ms: number; ok: boolean }
export interface LinkStats { n: number; failRate: number; p95Ms: number | null }
export interface Promotion { chainKey: string; group: string; leader: string; declared: string; since: number; reason: string }

const samples = new Map<string, Sample[]>();
const promotions = new Map<string, Promotion>();

export const namesItself = (providerId: string): boolean => providerId.startsWith('deployment:') || providerId.startsWith('local:');
export const linkKey = (t: Pick<Reorderable, 'providerId' | 'model'>) => (t.model && !namesItself(t.providerId) ? `${t.providerId}:${t.model}` : t.providerId);

const stageOf = (stage: string) => (stage === 'llm' ? 'chat' : stage);

export function recordLinkOutcome(stage: string, t: Pick<Reorderable, 'providerId' | 'model'>, ms: number, ok: boolean, now = Date.now()): void {
  if (t.providerId.startsWith('deployment:')) return;
  const key = `${stageOf(stage)}|${linkKey(t)}`;
  const list = samples.get(key) ?? [];
  list.push({ at: now, ms, ok });
  samples.set(key, list.slice(-REORDER.samplesKept));
}

export function linkStats(stage: string, t: Pick<Reorderable, 'providerId' | 'model'>, now = Date.now()): LinkStats {
  const recent = (samples.get(`${stageOf(stage)}|${linkKey(t)}`) ?? []).filter(s => now - s.at <= REORDER.windowMs);
  const ok = recent.filter(s => s.ok).map(s => s.ms).sort((a, b) => a - b);
  return {
    n: recent.length,
    failRate: recent.length ? (recent.length - ok.length) / recent.length : 0,
    p95Ms: ok.length ? ok[Math.min(ok.length - 1, Math.ceil(ok.length * 0.95) - 1)]! : null,
  };
}

const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);
const percent = (v: number) => `${Math.round(v * 100)} %`;

function badReason(leader: LinkStats, other: LinkStats): string | null {
  if (leader.n < REORDER.minSamples || other.n < REORDER.minSamples || other.failRate > REORDER.healthyFailRate) return null;
  if (leader.failRate >= REORDER.promoteFailRate) return `falhas ${percent(leader.failRate)} vs ${percent(other.failRate)}`;
  if (leader.p95Ms !== null && other.p95Ms !== null && leader.p95Ms >= other.p95Ms * REORDER.slowerFactor) return `p95 ${seconds(other.p95Ms)} vs ${seconds(leader.p95Ms)}`;
  return null;
}

function recovered(declared: LinkStats, leader: LinkStats): boolean {
  return declared.n >= REORDER.minSamples && declared.failRate <= REORDER.healthyFailRate
    && declared.p95Ms !== null && (leader.p95Ms === null || declared.p95Ms <= leader.p95Ms * REORDER.revertSlack);
}

function audit(event: 'route.reorder' | 'route.reorder_reverted', p: Promotion, reason: string): void {
  const [stage, alias] = p.chainKey.split('|');
  emitGatewayEvent(event, { level: event === 'route.reorder' ? 'warn' : 'info', attrs: { stage, alias, group: p.group, leader: p.leader, declared: p.declared, reason } });
}

function decide(stage: string, members: Reorderable[], now: number): Promotion | null {
  const chainKey = members[0]!.chainKey!;
  const group = members[0]!.group!;
  const id = `${chainKey}|${group}`;
  const declared = linkKey(members[0]!);
  const current = promotions.get(id) ?? null;
  const statsOf = (key: string) => linkStats(stage, members.find(m => linkKey(m) === key)!, now);
  if (current && !members.some(m => linkKey(m) === current.leader)) promotions.delete(id);
  const live = promotions.get(id) ?? null;
  if (live) {
    const dwell = now - live.since;
    if (dwell < REORDER.minDwellMs) return live;
    const back = recovered(statsOf(declared), statsOf(live.leader)) ? 'a primeira voltou ao normal' : dwell >= REORDER.maxDwellMs ? 'reavaliação após 30 min' : null;
    if (!back) return live;
    promotions.delete(id);
    audit('route.reorder_reverted', live, back);
    return null;
  }
  const leaderStats = statsOf(declared);
  const best = members.slice(1).map(m => ({ m, s: linkStats(stage, m, now) }))
    .filter(x => badReason(leaderStats, x.s))
    .sort((a, b) => (a.s.p95Ms ?? Infinity) - (b.s.p95Ms ?? Infinity))[0];
  if (!best) return null;
  const promotion = { chainKey, group, leader: linkKey(best.m), declared, since: now, reason: `promovida: ${badReason(leaderStats, best.s)}` };
  promotions.set(id, promotion);
  audit('route.reorder', promotion, promotion.reason);
  return promotion;
}

export function orderTargets<T extends Reorderable>(stage: string, targets: T[], now = Date.now()): T[] {
  const groups = new Map<string, T[]>();
  for (const t of targets) if (t.group && t.chainKey && !t.providerId.startsWith('deployment:')) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  let out = targets;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const p = decide(stage, members, now);
    if (!p) continue;
    const leader = members.find(m => linkKey(m) === p.leader)!;
    const ordered = [leader, ...members.filter(m => m !== leader)];
    const slots = out.map((t, i) => (members.includes(t) ? i : -1)).filter(i => i >= 0);
    out = [...out];
    slots.forEach((slot, k) => { out[slot] = ordered[k]!; });
  }
  return out;
}

export const reorderSnapshot = (): Promotion[] => [...promotions.values()].map(p => ({ ...p }));

export function resetLinkReorder(): void {
  samples.clear();
  promotions.clear();
}
