import type { AdminSnapshot } from '../../src/admin-page';
import type { DeploymentView, ReplicaView } from '../../src/deployments/types';
import type { ContainerLogView } from '../../src/deployments/container-logs';
import type { KeyView } from '../../src/config/access-keys';
import { DEFAULT_GPU_POLICY } from '../../src/config/access-keys';
import type { StoredTelemetryEvent } from '../../src/telemetry/contract';
import { adminTraffic, type DayUse } from '../../src/admin-page/traffic';
import type { ChainReport, LinkState } from '../../src/config/stage-chains';
import { parisDay, type SpendLedgerView } from '../../src/deployments/spend-ledger';
import { withBoots } from './admin-boot';
import { findOverspend } from '../../src/telemetry/overspend';
import type { ModelPrice } from '../../src/admin-page/model-prices';
import type { VoiceTurn } from '../../src/app-telemetry/voice-turn';
import type { Incident, IncidentActionKind } from '../../src/telemetry/incidents';
import { localClock } from '../../src/deployments/autoscale';

const iso = (now: number, minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const replica = (id: string, ageMinutes: number, pricePerHour: number, extra: Partial<ReplicaView> = {}): ReplicaView => ({
  id, phase: 'ready', ip: '10.0.0.1', providerState: 'running', provider: 'scaleway', zone: 'fr-par-2', machineType: 'L4-1-24G', pricePerHour,
  ageSeconds: ageMinutes * 60, inflight: 0, busy: false, draining: false, stagesOut: [], rttMs: 12, rttBaselineMs: 11, udp: 'ok',
  hostEndsInMinutes: null, expiresInMinutes: null, ...extra,
});

const deployment = (name: string, replicas: ReplicaView[], schedule: Array<{ days: number[]; start: string; end: string }>, extra: Partial<DeploymentView> = {}, spec: Record<string, unknown> = {}) => ({
  name, status: replicas.length ? 'ready' : 'scaled-to-zero', desiredReplicas: replicas.length, replicas, inflight: 0, waiting: 0,
  lastRequestAt: null, lastError: null, invokeUrl: '', app: 'parle', appImage: null, publicIp: null, lastPlacement: null, warm: null,
  realtime: null, sessions: 0, hold: null, pinned: null, warnings: [],
  autoscale: { desired: replicas.length, pressureWant: 0, reason: 'base', blockedBy: null, floor: 0, warmFloor: 0, load: 0, p95Ms: null, errorRate: 0 },
  spec: { minReplicas: 0, idleMinutes: 15, maxEurPerHour: 0.9, warmSchedule: schedule.map(s => ({ ...s, minReplicas: 1, timeZone: 'Europe/Paris' })), ...spec },
  ...extra,
}) as unknown as DeploymentView;

const key = (id: string, user: string, role: KeyView['role'], lastUsedAt: string | null, policy: Partial<KeyView['policy']> = {}, label: string | null = null): KeyView => ({
  id, source: id.startsWith('env-') ? 'env' : 'issued', user, role, admin: role === 'admin', prefix: '', label, createdAt: null, lastUsedAt,
  expiresAt: null, revokedAt: null, active: true, policy: { ...DEFAULT_GPU_POLICY, ...policy },
});

const STAGE_MS: Record<string, number> = { stt: 380, chat: 520, tts: 640 };

function trafficRows(now: number, state: DemoState): StoredTelemetryEvent[] {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows: StoredTelemetryEvent[] = [];
  const push = (rxTs: number, event: string, level: StoredTelemetryEvent['level'], extra: Partial<StoredTelemetryEvent> = {}) =>
    rows.push({ seq: rows.length, rxTs, ts: rxTs, source: 'gateway', level, event, traceId: '1'.repeat(32), ...extra });
  for (let h = 23; h >= 0; h--) {
    const start = now - h * 3_600_000 - 3_599_000;
    const parisHour = (new Date(start).getUTCHours() + 2) % 24;
    const inClass = parisHour >= 17 && parisHour <= 20;
    const calls = inClass ? 140 + Math.round(rand() * 60) : parisHour >= 8 && parisHour < 23 ? 18 + Math.round(rand() * 22) : Math.round(rand() * 4);
    for (let c = 0; c < calls; c++) {
      const at = start + Math.round(rand() * 3_590_000);
      const stage = ['stt', 'chat', 'tts'][c % 3]!;
      const failing = state === 'bad' && stage === 'tts' && h === 0;
      const app = !failing && c % (inClass ? 5 : 2) === 1 ? 'babelcast' : 'parle';
      const provider = app === 'babelcast' ? (stage === 'tts' ? 'deployment:babel-live' : 'openrouter') : inClass ? 'deployment:speech-stack' : 'openrouter';
      const model = provider === 'openrouter' ? CLOUD[`parle-${stage}`]!.slice('openrouter:'.length) : null;
      if (failing || (state === 'warn' && h === 5 && c === 3)) {
        push(at, 'route.fallback', 'warn', { app, attrs: { stage, provider, model } });
        push(at + 5, 'route.unavailable', 'error', { app, durMs: 30_000, attrs: { stage } });
        continue;
      }
      if (state !== 'ok' && rand() < 0.03) push(at, 'route.fallback', 'warn', { app, attrs: { stage, provider, model } });
      push(at + 10, 'route.served', 'info', { app, durMs: Math.round(STAGE_MS[stage]! * (0.6 + rand() * (rand() < 0.08 ? 3 : 0.9))), attrs: { stage, provider, model } });
    }
  }
  if (state === 'bad') for (let i = 0; i < 14; i++) push(now - (2 + i * 3) * 60_000, 'route.unavailable', 'error', { app: 'parle', durMs: 30_000, attrs: { stage: 'tts' } });
  for (let h = 7 * 24 - 1; h >= 0; h--) {
    push(now - h * 3_600_000 - 1_800_000, 'usage.cost', 'info', { app: 'parle', attrs: { stage: 'chat', provider: 'openrouter', model: 'google/gemini-2.5-flash', costUsd: 0.017 } });
  }
  const lifecycle: Array<[number, string, StoredTelemetryEvent['level'], string]> = [
    [520, 'autoscale.warm', 'info', 'speech-stack'], [519, 'replica.creating', 'info', 'speech-stack'], [512, 'replica.ready', 'info', 'speech-stack'],
    [340, 'replica.parked', 'info', 'speech-stack'], [40, 'replica.ready', 'info', 'babel-live'], [96, 'replica.power_on', 'info', 'speech-stack'], [95, 'replica.ready', 'info', 'speech-stack'],
  ];
  if (state !== 'ok') lifecycle.push([62, 'replica.creating', 'info', 'speech-stack-test'], [58, 'replica.create_failed', 'error', 'speech-stack-test']);
  if (state === 'bad') lifecycle.push([3, 'stage.on_fallback', 'warn', 'speech-stack'], [2, 'app.degraded', 'warn', 'speech-stack']);
  for (const [min, event, level, deployment] of lifecycle) push(now - min * 60_000, event, level, { deployment, replicaId: 'scw-1a2b' });
  return rows.sort((a, b) => a.rxTs - b.rxTs).map((r, i) => ({ ...r, seq: i }));
}

const CLOUD: Record<string, string> = {
  'parle-stt': 'openrouter:openai/whisper-large-v3', 'parle-chat': 'openrouter:google/gemini-2.5-flash', 'parle-tts': 'openrouter:hexgrad/kokoro-82m',
  'babel-tts': 'openrouter:openai/gpt-4o-mini-tts', 'babel-chat': 'openrouter:google/gemini-2.5-flash',
};

function chain(gpu: string | null, gpuState: LinkState, cloud: string): ChainReport {
  const links = [...(gpu ? [{ target: `deployment:${gpu}`, state: gpuState }] : []), { target: cloud, state: 'ready' as LinkState }];
  const serving = links.find(l => l.state === 'ready')?.target ?? null;
  return { serving, onFallback: serving !== links[0]!.target, links };
}

function withGroq(c: ChainReport): ChainReport {
  return { ...c, links: [...c.links, { target: 'groq:whisper-large-v3', state: 'ready' }] };
}

export function demoChains(state: DemoState): Record<string, Record<string, ChainReport>> {
  const parleGpu: LinkState = state === 'ok' ? 'cold' : 'ready';
  const stt = chain('speech-stack', parleGpu, CLOUD['parle-stt']!);
  const chat = chain('speech-stack', parleGpu, CLOUD['parle-chat']!);
  return {
    stt: { 'parle-stt': state === 'warn' ? withGroq(stt) : stt },
    chat: {
      'parle-chat': state === 'warn' ? { ...chat, links: [...chat.links, { target: 'openrouter:google/gemini-2.5-flash-lite', state: 'ready' }] } : chat,
      'babel-chat': chain('babelcast-3090', state === 'ok' ? 'ready' : 'cold', CLOUD['babel-chat']!),
    },
    tts: { 'parle-tts': chain('speech-stack', state === 'bad' ? 'circuit_open' : parleGpu, CLOUD['parle-tts']!), 'babel-tts': chain('babel-live', 'ready', CLOUD['babel-tts']!) },
  };
}

export const DEMO_PRICES: Record<string, ModelPrice> = {
  'google/gemini-2.5-flash': { prompt: 0.0000003, completion: 0.0000025 }, 'google/gemini-2.5-flash-lite': { prompt: 0.0000001, completion: 0.0000004 },
  'openai/whisper-large-v3': { prompt: 0.0000075, completion: 0 }, 'hexgrad/kokoro-82m': { prompt: 0.00000062, completion: 0 },
};

export const demoStates = ['warn', 'ok', 'bad'] as const;
export type DemoState = typeof demoStates[number];

export function demoSpend(now: number, state: DemoState = 'warn'): SpendLedgerView {
  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const days: SpendLedgerView['days'] = [];
  for (let i = 29; i >= 0; i--) {
    const at = now - i * 86_400_000;
    const weekday = new Date(at).getUTCDay();
    const classDay = weekday >= 1 && weekday <= 4;
    const today = i === 0;
    const spike = today && state !== 'ok' ? (state === 'bad' ? 2.6 : 2.1) : 1;
    const parleEur = (classDay ? 1.9 + rand() * 1.1 : 0.15 + rand() * 0.3) * spike;
    const babelEur = (0.45 + rand() * 0.6) * (today && state === 'bad' ? 2.4 : 1);
    const parleReq = Math.round(classDay ? 1500 + rand() * 1400 : 120 + rand() * 200);
    const babelReq = Math.round(150 + rand() * 250);
    days.push({
      day: parisDay(at),
      apps: {
        parle: { gpuEur: Math.round(parleEur * 100) / 100, requests: parleReq, tokens: parleReq * (180 + Math.round(rand() * 60)), cloudUsd: Math.round(parleReq * 0.018) / 100 },
        babelcast: { gpuEur: Math.round(babelEur * 100) / 100, requests: babelReq, tokens: babelReq * (150 + Math.round(rand() * 50)), cloudUsd: Math.round(babelReq * 0.04) / 100 },
      },
    });
  }
  return { since: days[0]!.day, days };
}

function lastMonday8(now: number): string {
  const day = new Date(now);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  day.setUTCHours(6, 0, 0, 0);
  return day.toISOString();
}

function demoDaily(now: number): DayUse[] {
  const out: DayUse[] = [];
  for (let i = 14; i >= 1; i--) {
    const day = parisDay(now - i * 86_400_000);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday < 1 || weekday > 4) continue;
    const slots = new Array<number>(288).fill(0);
    for (let m = 17 * 60 + 35; m <= 19 * 60 + 45; m += 5) slots[m / 5] = 20;
    out.push({ day, slots });
  }
  return out;
}

interface TurnHealth { fail: number; scale: number; degraded: number; reasons: Array<[string, string]> }
const CALM: TurnHealth = { fail: 0.003, scale: 1, degraded: 0, reasons: [['tts', 'timeout'], ['stt', 'empty_audio']] };
const LIVE: Record<DemoState, TurnHealth> = {
  ok: CALM,
  warn: { fail: 0.045, scale: 1.6, degraded: 0.15, reasons: [['tts', 'timeout'], ['tts', 'timeout'], ['stt', 'empty_audio']] },
  bad: { fail: 0.17, scale: 4.1, degraded: 0.6, reasons: [['tts', 'upstream_502'], ['tts', 'upstream_502'], ['tts', 'timeout'], ['llm', 'timeout']] },
};

export function demoTurns(now: number, state: DemoState): VoiceTurn[] {
  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out: VoiceTurn[] = [];
  const between = (from: number, to: number, health: (at: number) => TurnHealth) => {
    for (let at = from; at <= to; at += 4_000 + Math.round(rand() * 6_000)) {
      const h = health(at);
      const failed = rand() < h.fail;
      const [stage, reason] = h.reasons[Math.floor(rand() * h.reasons.length)]!;
      out.push({
        at, app: 'parle', ok: !failed, failedStage: failed ? stage : null, reason: failed ? reason : null,
        requestId: Math.floor(rand() * 2 ** 48).toString(16).padStart(12, '0'),
        totalMs: failed ? null : Math.round((650 + rand() * 400 + (rand() < 0.06 ? 450 : 0)) * h.scale),
        degraded: rand() < h.degraded ? ['tts'] : [], stage: rand() < 0.8 ? '360' : 'fast', classWindow: true,
      });
    }
  };
  if (state === 'ok') between(now - 210 * 60_000, now - 60 * 60_000, () => CALM);
  else {
    between(now - 1464 * 60_000, now - 1315 * 60_000, () => CALM);
    between(now - 48 * 60_000, now, at => (now - at <= 11 * 60_000 ? LIVE[state] : { ...CALM, fail: 0.012 }));
  }
  return out;
}

function incident(now: number, event: string, key: string, startMin: number, endMin: number | null, summaries: string[],
  actions: Array<[number, IncidentActionKind, string, string]> = [], resolution: Incident['resolution'] = 'cleared'): Incident {
  return {
    id: `${event}|${key}|${now - startMin * 60_000}`, event, key, startedAt: iso(now, startMin), lastSeenAt: iso(now, endMin ?? 0), endedAt: endMin === null ? null : iso(now, endMin),
    alerts: summaries.map((summary, i) => ({ at: iso(now, startMin - i * 30), summary })).reverse(), alertCount: summaries.length,
    actions: actions.map(([min, kind, target, detail]) => ({ at: iso(now, min), kind, target, detail })), resolution: endMin === null ? null : resolution, mailed: true,
  };
}

export function demoIncidents(now: number, state: DemoState): Incident[] {
  const past = [
    incident(now, 'deployment.create_failed', 'speech-stack-test', 58, 28, ['deployment: speech-stack-test, error: create: L4-1-24G out of stock in fr-par-2'], [], 'quiet'),
    incident(now, 'fallback.probe_failed', 'tts|openrouter:hexgrad/kokoro-82m|pm_alex', 1500, 1455,
      ['stage: tts, count: 1, items: tts openrouter:hexgrad/kokoro-82m (pm_alex) [parle-tts]: (upstream_error) provider timeout'],
      [[1490, 'reorder', 'parle-tts', 'deepinfra:hexgrad/Kokoro-82M antes de openrouter:hexgrad/kokoro-82m']]),
    incident(now, 'gpu.outside_window', 'speech-stack', 1720, 1659, ['deployment: speech-stack, replicas: 1, minutes: 31, eurPerHour: 0.79', 'deployment: speech-stack, replicas: 1, minutes: 61, eurPerHour: 0.79'],
      [[1660, 'park', 'speech-stack', 'gateway: 60 min fora da janela de aula']]),
  ];
  if (state === 'ok') return [incident(now, 'voice.turn_slow', 'parle', 2900, 2888, ['app: parle, turns: 64, failed: 0, p95Ms: 4310']), ...past.slice(1)];
  const warn = [
    incident(now, 'gpu.idle', 'babel-live', 22, null, ['deployment: babel-live, minutes: 18, eurPerHour: 0.79, wastedEur: 0.24']),
    incident(now, 'gpu.outside_window', 'speech-stack', 35, null, ['deployment: speech-stack, replicas: 1, minutes: 35, eurPerHour: 0.79']),
    ...past,
  ];
  if (state === 'warn') return warn;
  return [
    incident(now, 'voice.turn_failing', 'parle', 9, null, ['app: parle, turns: 88, failed: 12, failedPct: 13.6, p95Ms: 4180, failures: tts/upstream_502 x7, tts/timeout x3, llm/timeout x2'],
      [[6, 'reorder', 'parle-tts', 'deepinfra:hexgrad/Kokoro-82M antes de openrouter:hexgrad/kokoro-82m']]),
    incident(now, 'fallback.probe_failed', 'tts|openrouter:hexgrad/kokoro-82m|pm_alex', 2, null,
      ['stage: tts, count: 1, items: tts openrouter:hexgrad/kokoro-82m (pm_alex) [parle-tts]: (upstream_error) provider timeout']),
    incident(now, 'deployment.stuck_boot', 'speech-stack-test', 4, null, ['deployment: speech-stack-test, phase: loading, minutes: 14, attempts: 2'],
      [[24, 'retry', 'speech-stack-test', 'réplica fr-par-2/b8f1']]),
    ...warn,
  ];
}

const parisHhmm = (at: number) => {
  const m = localClock(at, 'Europe/Paris').minutes;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function demoSnapshot(now: number, state: DemoState = 'warn'): AdminSnapshot {
  const traffic = adminTraffic(trafficRows(now, state), now);
  const snapshot = {
    ...warnSnapshot(now), traffic: { ...traffic, daily: { ...traffic.daily, parle: demoDaily(now) } }, spend: demoSpend(now, state), dismissed: {}, chains: demoChains(state),
    reorders: state === 'warn' ? [{
      chainKey: 'stt|parle-stt', group: 'stt:multi', leader: 'groq:whisper-large-v3', declared: 'openrouter:openai/whisper-large-v3',
      since: now - 12 * 60_000, reason: 'promovida: p95 0,4 s vs 1,3 s',
    }] : [],
    digest: { enabled: true, lastSentAt: lastMonday8(now), lastKind: 'weekly' as const },
    ttsCache: {
      entries: 412, bytes: 21.4 * 1024 * 1024, maxBytes: 64 * 1024 * 1024, diskBytes: 88 * 1024 * 1024, diskMaxBytes: 200 * 1024 * 1024, ttlHours: 24,
      hits: 1840, misses: 2310, bypassed: 12, evictions: state === 'bad' ? 96 : 0, savedMs: 1840 * 640,
      byApp: { parle: { hits: 1700, misses: 1500, bypassed: 0, savedMs: 1700 * 650 }, babelcast: { hits: 140, misses: 810, bypassed: 12, savedMs: 140 * 520 } },
    },
    about: { commit: '0a52749c1d2e3f4a5b6c7d8e9f00112233445566', uptimeSeconds: 4 * 3600 + 1260, region: 'europe-west4', telemetryAt: iso(now, 0) },
    modelPrices: state === 'warn' ? { at: iso(now, 300), models: DEMO_PRICES } : null,
    voiceTurns: demoTurns(now, state),
    incidents: demoIncidents(now, state),
  };
  if (state === 'ok') return allGreen(snapshot, now);
  if (state === 'bad') return withBoots(somethingDown(snapshot, now), now, true);
  return withBoots(snapshot, now, false);
}

function allGreen(s: AdminSnapshot, now: number): AdminSnapshot {
  return {
    ...s,
    balances: s.balances.map(b => (b.provider === 'vast' ? { ...b, level: 'ok', balanceUsd: 38.5, hoursLeft: 128, reasons: [] } : b)),
    gpus: s.gpus!.map(d => (d.name === 'babel-live' ? { ...d, lastRequestAt: iso(now, 2) } : d.name === 'speech-stack' ? {
      ...d, status: 'scaled-to-zero', desiredReplicas: 0, replicas: [], lastRequestAt: iso(now, 62),
      spec: { ...d.spec, warmSchedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: parisHhmm(now - 210 * 60_000), end: parisHhmm(now - 60 * 60_000), minReplicas: 1, timeZone: 'Europe/Paris' }] },
    } as DeploymentView : d)),
    apps: s.apps.map(a => (a.status ? { ...a, status: { ...a.status, mode: 'degraded' as const, deployments: a.status.deployments.map(x => ({ ...x, state: 'stopped' as const, replicas: { ready: 0, total: 0 } })) } } : a)),
    gpuSpend: s.gpuSpend && { ...s.gpuSpend, running: [] },
    alerts: s.alerts.filter(a => a.event !== 'gpu.idle').map(a => ({ ...a, at: iso(now, 300) })),
    audit: s.audit.filter(e => e.ok),
    reserves: { ...s.reserves, links: s.reserves.links.map(r => ({ ...r, content: 'ok' as const, contentNote: null })) },
  };
}

function monthElapsed(now: number): number {
  const at = new Date(now);
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  return (now - start) / (Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1) - start);
}

function somethingDown(s: AdminSnapshot, now: number): AdminSnapshot {
  return {
    ...s,
    overspend: findOverspend({ now, spend: s.spend ?? null, gpus: s.gpus ?? [], keys: s.keys, gpuSpend: s.gpuSpend, machines: s.machines, rows: [], appOf: d => d.app }),
    reserves: {
      ...s.reserves,
      links: s.reserves.links.map(r => (r.stage === 'tts' ? { ...r, ok: false, status: 502, code: 'upstream_error', latencyMs: 30000, error: 'provider timeout', checkedAt: iso(now, 2) } : r)),
    },
    apps: s.apps.map(a => (a.status ? { ...a, status: { ...a.status, mode: 'down' } } : a)),
    balances: s.balances.map(b => (b.provider === 'scaleway' ? { ...b, monthEur: Math.round(260 * monthElapsed(now) * 100) / 100 } : b)),
    alerts: [
      { event: 'fallback.probe_failed', at: iso(now, 2), summary: 'stage: tts, target: openrouter:hexgrad/kokoro-82m, code: upstream_error' },
      { event: 'spend.over', at: iso(now, 6), summary: 'quem: app parle, gasto: GPU de parle hoje acima do normal, causa: speech-stack ligada pela chave parle (producao)' },
      ...s.alerts,
    ],
    audit: [{ at: iso(now, 1), actor: 'marcos', action: 'admin-page.probe', names: [], ok: true }, ...s.audit],
  };
}

function warnSnapshot(now: number): AdminSnapshot {
  const notToday = (new Date(now).getDay() + 3) % 7;
  return {
    reserves: {
      intervalMinutes: 15,
      links: [
        { stage: 'stt', target: 'openrouter:openai/whisper-large-v3', providerId: 'openrouter', aliases: ['parle-stt'], ok: true, status: 200, code: null, latencyMs: 812, checkedAt: iso(now, 4), error: null, content: 'ok', contentNote: null },
        { stage: 'chat', target: 'openrouter:google/gemini-2.5-flash', providerId: 'openrouter', aliases: ['parle-chat'], ok: true, status: 200, code: null, latencyMs: 640, checkedAt: iso(now, 4), error: null, content: 'ok', contentNote: null },
        { stage: 'tts', target: 'openrouter:hexgrad/kokoro-82m', providerId: 'openrouter', voice: 'pm_alex', aliases: ['parle-tts'], ok: true, status: 200, code: null, latencyMs: 1290, checkedAt: iso(now, 4), error: null, content: 'ok', contentNote: null },
        { stage: 'tts', target: 'openrouter:openai/gpt-4o-mini-tts', providerId: 'openrouter', voice: 'alloy', aliases: ['babel-tts'], ok: true, status: 200, code: null, latencyMs: 980, checkedAt: iso(now, 4), error: null,
          content: 'mismatch', contentNote: 'áudio em silêncio (RMS 12)' },
      ],
    },
    balances: [
      { provider: 'openrouter', level: 'ok', balanceUsd: 42.1, burnPerHour: 0.4, currency: 'USD', hoursLeft: 105, keyExpiresAt: null, monthEur: null, monthCapEur: null, source: 'api', reasons: [], error: null, checkedAt: iso(now, 6) },
      { provider: 'vast', level: 'warn', balanceUsd: 7.8, burnPerHour: 0.3, currency: 'USD', hoursLeft: 26, keyExpiresAt: null, monthEur: null, monthCapEur: null, source: 'api', reasons: ['saldo abaixo de US$ 10'], error: null, checkedAt: iso(now, 6) },
      { provider: 'scaleway', level: 'ok', balanceUsd: null, burnPerHour: 0.79, currency: 'EUR', hoursLeft: null, keyExpiresAt: null, monthEur: 61.3, monthCapEur: 200, source: 'gateway', reasons: [], error: null, checkedAt: iso(now, 6) },
    ],
    providerCredit: [],
    gpus: [
      deployment('speech-stack', [replica('scw-1a2b', 95, 0.79)], [{ days: [notToday], start: '17:40', end: '20:15' }, { days: [1, 2, 3, 4], start: '17:30', end: '20:30' }],
        { lastRequestAt: iso(now, 3) }, { idleMinutes: 45 }),
      deployment('parle-bridge-shadow', [], []),
      deployment('speech-stack-test', [], [], { warm: null }),
      deployment('babel-live', [replica('scw-9z8y', 40, 0.79)], [], { app: 'babelcast', lastRequestAt: iso(now, 50) }),
      deployment('babelcast-3090', [replica('31544017', 180, 0.181, { provider: 'vast', zone: 'Lyon, FR', machineType: 'RTX 3090', ip: null })], [], {
        app: 'babelcast', lastRequestAt: iso(now, 4), pinned: { idleMinutes: 60, parked: false },
      }, { provider: 'vast', machineType: 'RTX 3090', minReplicas: 1, idleMinutes: 60, maxEurPerHour: 0.19, testFor: 'babelcast-speech' }),
    ],
    gpuSpend: {
      spentEur: { 'key-0f3a9c11d2e4': 1.2, 'env-parle': 2.65 },
      running: [{ key: 'env-parle', deployment: 'speech-stack', until: iso(now, -25), capEur: null }],
    },
    alerts: [
      { event: 'gpu.idle', at: iso(now, 22), summary: 'deployment: babel-live, minutes: 18, eurPerHour: 0.79, wastedEur: 0.24' },
      { event: 'gpu.outside_window', at: iso(now, 35), summary: 'deployment: speech-stack, replicas: 1, minutes: 35, eurPerHour: 0.79' },
      { event: 'balance.warn', at: iso(now, 300), summary: 'subject: Vast: saldo US$ 7,80 (~26 h)' },
      { event: 'app.budget_warn', at: iso(now, 320), summary: 'app: babelcast, requests: 1600, limit: 2000' },
    ],
    machines: {
      global: { dayUsd: 0.42, committedUsd: 0.6, capDayUsd: 10 },
      machines: [{ id: 'm-7c1e', owner: 'palco', holder: 'agente-camera', provider: 'vast', status: 'running', usdPerHour: 0.09, costUsd: 0.42 }],
    },
    keys: [
      key('env-marcos', 'marcos', 'admin', iso(now, 2), { autoWake: true, canStartGpu: true, gpuDailyEur: null }),
      key('env-parle', 'parle', 'client', iso(now, 1), { autoWake: true, canStartGpu: true, gpuDailyEur: null }, 'producao'),
      key('key-0f3a9c11d2e4', 'parle-dev', 'client', iso(now, 50), { countsAsUse: false, wakeDeployments: ['speech-stack-test', 'babelcast-3090'], gpuDailyEur: 3 }, 'agentes'),
      key('key-88b0aa31c7f0', 'babelcast', 'client', iso(now, 8), { neverWake: true }, 'legendas-ao-vivo'),
    ],
    apps: [
      {
        id: 'parle', profile: { requiresGpu: true, gpuDeployments: ['speech-stack'] }, aliases: ['parle-stt', 'parle-chat', 'parle-tts'],
        stages: { stt: ['parle-stt'], chat: ['parle-chat'], tts: ['parle-tts'] },
        routes: {
          stt: { 'parle-stt': [{ provider: 'deployment', deployment: 'speech-stack' }, { provider: 'openrouter', model: 'openai/whisper-large-v3' }, { provider: 'groq', model: 'whisper-large-v3' }] },
          chat: { 'parle-chat': [{ provider: 'deployment', deployment: 'speech-stack' }, { provider: 'openrouter', model: 'google/gemini-2.5-flash', equivalent: 'conversa' },
            { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite', equivalent: 'conversa' }] },
          tts: { 'parle-tts': [{ provider: 'deployment', deployment: 'speech-stack' }, { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'pm_alex' }] },
        },
        status: {
          app: 'parle', requiresGpu: true, mode: 'gpu', checkedAt: iso(now, 1),
          deployments: [{ name: 'speech-stack', stages: ['stt', 'llm', 'tts'], state: 'ready', replicas: { ready: 1, total: 1 }, lastProbe: { at: iso(now, 1), ok: true, ms: 420, error: null } }],
          fallback: { active: false, since: null, last: null },
        },
      },
      { id: 'babelcast', profile: null, status: null, aliases: ['babel-chat', 'babel-tts'], stages: { chat: ['babel-chat'], tts: ['babel-tts'] } },
    ],
    appBudgets: [
      { app: 'parle', resetAt: iso(now, -600), requests: { used: 1840, limit: 20000, perMinute: 3.1, exhaustedAt: null }, tokens: { used: 412000, limit: 5000000, perMinute: 700, exhaustedAt: null } },
      { app: 'babelcast', resetAt: iso(now, -600), requests: { used: 212, limit: 2000, perMinute: 0.2, exhaustedAt: null }, tokens: { used: 38500, limit: 500000, perMinute: 40, exhaustedAt: null } },
    ],
    traffic: null,
    audit: [
      { at: iso(now, 12), actor: 'marcos', action: 'admin-page.login', names: [], ok: true },
      { at: iso(now, 58), actor: 'marcos', action: 'admin-page.park', names: ['speech-stack-test'], ok: false, detail: 'réplica ainda criando' },
      { at: iso(now, 140), actor: 'palco-reload', action: 'provider-keys.applied', names: ['OPENROUTER_API_KEY'], ok: true },
      { at: iso(now, 345), actor: 'marcos', action: 'admin-page.park', names: ['speech-stack'], ok: true },
    ],
  };
}

const DEMO_CONTAINER_LINES = [
  'Welcome to vast.ai. If authentication fails, try again after a few seconds, and double check your ssh key.',
  'Have fun!',
  'Starting OpenBSD Secure Shell server: sshd.',
  'HF_TOKEN=[segredo] python3 -m babelcast.serve --port 8010',
  'INFO:     Started server process [412]',
  'INFO:     Waiting for application startup.',
  'Loading faster-whisper large-v3 (float16) ...',
  'Loading Kokoro-82M voices: pf_dora, pm_alex',
  'INFO:     Application startup complete.',
  'INFO:     Uvicorn running on http://127.0.0.1:8010 (Press CTRL+C to quit)',
  'INFO:     127.0.0.1:51822 - "GET /health HTTP/1.1" 200 OK',
];

export function demoContainerLog(name: string, now: number): ContainerLogView {
  if (name !== 'babelcast-3090') return { reason: 'unsupported', pending: false, log: null };
  return { reason: null, pending: false, log: { deployment: name, replicaId: '31544017', at: now - 90_000, lines: DEMO_CONTAINER_LINES, error: null } };
}
