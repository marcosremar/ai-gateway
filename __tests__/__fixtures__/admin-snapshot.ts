import type { AdminSnapshot } from '../../src/admin-page';
import type { DeploymentView, ReplicaView } from '../../src/deployments/types';
import type { KeyView } from '../../src/config/access-keys';
import { DEFAULT_GPU_POLICY } from '../../src/config/access-keys';

const iso = (now: number, minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const replica = (id: string, ageMinutes: number, pricePerHour: number): ReplicaView => ({
  id, phase: 'ready', ip: '10.0.0.1', providerState: 'running', zone: 'fr-par-2', machineType: 'L4-1-24G', pricePerHour,
  ageSeconds: ageMinutes * 60, inflight: 0, busy: false, draining: false, stagesOut: [], rttMs: 12, rttBaselineMs: 11, udp: 'ok',
  hostEndsInMinutes: null, expiresInMinutes: null,
});

const deployment = (name: string, replicas: ReplicaView[], schedule: Array<{ days: number[]; start: string; end: string }>, extra: Partial<DeploymentView> = {}) => ({
  name, status: replicas.length ? 'ready' : 'scaled-to-zero', desiredReplicas: replicas.length, replicas, inflight: 0, waiting: 0,
  lastRequestAt: null, lastError: null, invokeUrl: '', app: 'parle', appImage: null, publicIp: null, lastPlacement: null, warm: null,
  realtime: null, sessions: 0, hold: null, warnings: [],
  spec: { warmSchedule: schedule.map(s => ({ ...s, minReplicas: 1, timeZone: 'Europe/Paris' })) },
  ...extra,
}) as unknown as DeploymentView;

const key = (id: string, user: string, role: KeyView['role'], lastUsedAt: string | null, policy: Partial<KeyView['policy']> = {}, label: string | null = null): KeyView => ({
  id, source: id.startsWith('env-') ? 'env' : 'issued', user, role, admin: role === 'admin', prefix: '', label, createdAt: null, lastUsedAt,
  expiresAt: null, revokedAt: null, active: true, policy: { ...DEFAULT_GPU_POLICY, ...policy },
});

export function demoSnapshot(now: number): AdminSnapshot {
  const notToday = (new Date(now).getDay() + 3) % 7;
  return {
    reserves: {
      intervalMinutes: 15,
      links: [
        { stage: 'stt', target: 'openrouter:openai/whisper-large-v3', providerId: 'openrouter', aliases: ['parle-stt'], ok: true, status: 200, code: null, latencyMs: 812, checkedAt: iso(now, 4), error: null },
        { stage: 'chat', target: 'openrouter:google/gemini-2.5-flash', providerId: 'openrouter', aliases: ['parle-chat'], ok: true, status: 200, code: null, latencyMs: 640, checkedAt: iso(now, 4), error: null },
        { stage: 'tts', target: 'openrouter:hexgrad/kokoro-82m', providerId: 'openrouter', voice: 'pm_alex', aliases: ['parle-tts'], ok: true, status: 200, code: null, latencyMs: 1290, checkedAt: iso(now, 4), error: null },
      ],
    },
    balances: [
      { provider: 'openrouter', level: 'ok', balanceUsd: 42.1, burnPerHour: 0.4, currency: 'USD', hoursLeft: 105, keyExpiresAt: null, monthEur: null, monthCapEur: null, source: 'api', reasons: [], error: null, checkedAt: iso(now, 6) },
      { provider: 'vast', level: 'warn', balanceUsd: 7.8, burnPerHour: 0.3, currency: 'USD', hoursLeft: 26, keyExpiresAt: null, monthEur: null, monthCapEur: null, source: 'api', reasons: ['saldo abaixo de US$ 10'], error: null, checkedAt: iso(now, 6) },
      { provider: 'scaleway', level: 'ok', balanceUsd: null, burnPerHour: 0.79, currency: 'EUR', hoursLeft: null, keyExpiresAt: null, monthEur: 61.3, monthCapEur: 200, source: 'gateway', reasons: [], error: null, checkedAt: iso(now, 6) },
    ],
    providerCredit: [],
    gpus: [
      deployment('speech-stack', [replica('scw-1a2b', 95, 0.79)], [{ days: [notToday], start: '17:40', end: '20:15' }]),
      deployment('parle-bridge-shadow', [], []),
      deployment('speech-stack-test', [], [], { warm: null }),
    ],
    gpuSpend: { spentEur: { 'key-0f3a9c11d2e4': 1.2 } },
    alerts: [
      { event: 'gpu.outside_window', at: iso(now, 35), summary: 'deployment: speech-stack, replicas: 1, minutes: 35, eurPerHour: 0.79' },
      { event: 'balance.warn', at: iso(now, 300), summary: 'subject: Vast: saldo US$ 7,80 (~26 h)' },
    ],
    machines: {
      global: { dayUsd: 0.42, committedUsd: 0.6, capDayUsd: 10 },
      machines: [{ id: 'm-7c1e', owner: 'palco', holder: 'agente-camera', provider: 'vast', status: 'running', usdPerHour: 0.09, costUsd: 0.42 }],
    },
    keys: [
      key('env-marcos', 'marcos', 'admin', iso(now, 2), { autoWake: true, canStartGpu: true, gpuDailyEur: null }),
      key('env-parle', 'parle', 'client', iso(now, 1), { autoWake: true, canStartGpu: true, gpuDailyEur: null }),
      key('key-0f3a9c11d2e4', 'parle-dev', 'client', iso(now, 50), { countsAsUse: false, wakeDeployments: ['speech-stack-test'], gpuDailyEur: 3 }, 'agentes'),
      key('key-88b0aa31c7f0', 'babelcast', 'client', null, { neverWake: true }),
    ],
    appBudgets: [
      { app: 'parle', resetAt: iso(now, -600), requests: { used: 1840, limit: 20000, perMinute: 3.1, exhaustedAt: null }, tokens: { used: 412000, limit: 5000000, perMinute: 700, exhaustedAt: null } },
    ],
  };
}
