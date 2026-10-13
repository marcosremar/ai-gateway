import type { AdminSnapshot } from '../../src/admin-page';
import type { DeploymentView, ReplicaView } from '../../src/deployments/types';
import type { KeyView } from '../../src/config/access-keys';
import { DEFAULT_GPU_POLICY } from '../../src/config/access-keys';
import type { StoredTelemetryEvent } from '../../src/telemetry/contract';
import { adminTraffic } from '../../src/admin-page/traffic';
import type { ChainReport, LinkState } from '../../src/config/stage-chains';
import { parisDay, type SpendLedgerView } from '../../src/deployments/spend-ledger';

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
      const provider = inClass ? 'deployment:speech-stack' : 'openrouter';
      const failing = state === 'bad' && stage === 'tts' && h === 0;
      if (failing || (state === 'warn' && h === 5 && c === 3)) {
        push(at, 'route.fallback', 'warn', { attrs: { stage, provider } });
        push(at + 5, 'route.unavailable', 'error', { durMs: 30_000, attrs: { stage } });
        continue;
      }
      if (state !== 'ok' && rand() < 0.03) push(at, 'route.fallback', 'warn', { attrs: { stage, provider } });
      push(at + 10, 'route.served', 'info', { durMs: Math.round(STAGE_MS[stage]! * (0.6 + rand() * (rand() < 0.08 ? 3 : 0.9))), attrs: { stage, provider } });
    }
  }
  if (state === 'bad') for (let i = 0; i < 14; i++) push(now - (2 + i * 3) * 60_000, 'route.unavailable', 'error', { durMs: 30_000, attrs: { stage: 'tts' } });
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

export function demoChains(state: DemoState): Record<string, Record<string, ChainReport>> {
  return {
    stt: { 'parle-stt': chain('speech-stack', 'ready', CLOUD['parle-stt']!) },
    chat: { 'parle-chat': chain('speech-stack', 'ready', CLOUD['parle-chat']!), 'babel-chat': chain('babelcast-3090', 'ready', CLOUD['babel-chat']!) },
    tts: { 'parle-tts': chain('speech-stack', state === 'bad' ? 'circuit_open' : 'ready', CLOUD['parle-tts']!), 'babel-tts': chain('babel-live', 'ready', CLOUD['babel-tts']!) },
  };
}

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
        parle: { gpuEur: Math.round(parleEur * 100) / 100, requests: parleReq, tokens: parleReq * (180 + Math.round(rand() * 60)) },
        babelcast: { gpuEur: Math.round(babelEur * 100) / 100, requests: babelReq, tokens: babelReq * (150 + Math.round(rand() * 50)) },
      },
    });
  }
  return { since: days[0]!.day, days };
}

export function demoSnapshot(now: number, state: DemoState = 'warn'): AdminSnapshot {
  const snapshot = {
    ...warnSnapshot(now), traffic: adminTraffic(trafficRows(now, state), now), spend: demoSpend(now, state), dismissed: {}, chains: demoChains(state),
    about: { commit: '0a52749c1d2e3f4a5b6c7d8e9f00112233445566', uptimeSeconds: 4 * 3600 + 1260, region: 'europe-west4', telemetryAt: iso(now, 0) },
  };
  if (state === 'ok') return allGreen(snapshot, now);
  if (state === 'bad') return somethingDown(snapshot, now);
  return snapshot;
}

function allGreen(s: AdminSnapshot, now: number): AdminSnapshot {
  return {
    ...s,
    balances: s.balances.map(b => (b.provider === 'vast' ? { ...b, level: 'ok', balanceUsd: 38.5, hoursLeft: 128, reasons: [] } : b)),
    gpus: s.gpus!.map(d => (d.name === 'babel-live' ? { ...d, lastRequestAt: iso(now, 2) } : d.name === 'speech-stack' ? { ...d, spec: { warmSchedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', minReplicas: 1, timeZone: 'Europe/Paris' }] } } as DeploymentView : d)),
    alerts: s.alerts.filter(a => a.event !== 'gpu.idle').map(a => ({ ...a, at: iso(now, 300) })),
    audit: s.audit.filter(e => e.ok),
  };
}

function somethingDown(s: AdminSnapshot, now: number): AdminSnapshot {
  return {
    ...s,
    reserves: {
      ...s.reserves,
      links: s.reserves.links.map(r => (r.stage === 'tts' ? { ...r, ok: false, status: 502, code: 'upstream_error', latencyMs: 30000, error: 'provider timeout', checkedAt: iso(now, 2) } : r)),
    },
    apps: s.apps.map(a => (a.status ? { ...a, status: { ...a.status, mode: 'down' } } : a)),
    alerts: [{ event: 'fallback.probe_failed', at: iso(now, 2), summary: 'stage: tts, target: openrouter:hexgrad/kokoro-82m, code: upstream_error' }, ...s.alerts],
    audit: [{ at: iso(now, 1), actor: 'marcos', action: 'admin-page.probe', names: [], ok: true }, ...s.audit],
  };
}

function warnSnapshot(now: number): AdminSnapshot {
  const notToday = (new Date(now).getDay() + 3) % 7;
  return {
    reserves: {
      intervalMinutes: 15,
      links: [
        { stage: 'stt', target: 'openrouter:openai/whisper-large-v3', providerId: 'openrouter', aliases: ['parle-stt'], ok: true, status: 200, code: null, latencyMs: 812, checkedAt: iso(now, 4), error: null },
        { stage: 'chat', target: 'openrouter:google/gemini-2.5-flash', providerId: 'openrouter', aliases: ['parle-chat'], ok: true, status: 200, code: null, latencyMs: 640, checkedAt: iso(now, 4), error: null },
        { stage: 'tts', target: 'openrouter:hexgrad/kokoro-82m', providerId: 'openrouter', voice: 'pm_alex', aliases: ['parle-tts'], ok: true, status: 200, code: null, latencyMs: 1290, checkedAt: iso(now, 4), error: null },
        { stage: 'tts', target: 'openrouter:openai/gpt-4o-mini-tts', providerId: 'openrouter', voice: 'alloy', aliases: ['babel-tts'], ok: true, status: 200, code: null, latencyMs: 980, checkedAt: iso(now, 4), error: null },
      ],
    },
    balances: [
      { provider: 'openrouter', level: 'ok', balanceUsd: 42.1, burnPerHour: 0.4, currency: 'USD', hoursLeft: 105, keyExpiresAt: null, monthEur: null, monthCapEur: null, source: 'api', reasons: [], error: null, checkedAt: iso(now, 6) },
      { provider: 'vast', level: 'warn', balanceUsd: 7.8, burnPerHour: 0.3, currency: 'USD', hoursLeft: 26, keyExpiresAt: null, monthEur: null, monthCapEur: null, source: 'api', reasons: ['saldo abaixo de US$ 10'], error: null, checkedAt: iso(now, 6) },
      { provider: 'scaleway', level: 'ok', balanceUsd: null, burnPerHour: 0.79, currency: 'EUR', hoursLeft: null, keyExpiresAt: null, monthEur: 61.3, monthCapEur: 200, source: 'gateway', reasons: [], error: null, checkedAt: iso(now, 6) },
    ],
    providerCredit: [],
    gpus: [
      deployment('speech-stack', [replica('scw-1a2b', 95, 0.79)], [{ days: [notToday], start: '17:40', end: '20:15' }], { lastRequestAt: iso(now, 3) }, { idleMinutes: 45 }),
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
