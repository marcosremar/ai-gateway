import { describe, expect, it } from 'vitest';
import { callSpikes, createOverspendWatch, dailyBaseline, findOverspend, overspendLimitsFromEnv, OVERSPEND_DEFAULTS, type OverspendInput } from '../../src/telemetry/overspend';
import { parisDay } from '../../src/deployments/spend-ledger';
import type { DeploymentView } from '../../src/deployments/types';
import type { StoredTelemetryEvent } from '../../src/telemetry/contract';
import type { AlertMail } from '../../src/telemetry/alert-email';
import { recommendations, scopeToApp } from '../../src/admin-page';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';

const NOW = Date.parse('2026-10-13T10:00:00Z');
const DAY = 86_400_000;
const gpu = (name: string, app: string, eurPerHour: number, extra: Partial<DeploymentView> = {}) => ({
  name, app, lastRequestAt: new Date(NOW - 60_000).toISOString(), spec: { idleMinutes: 15, minReplicas: 0 },
  replicas: eurPerHour ? [{ id: `${name}-r`, phase: 'ready', pricePerHour: eurPerHour, ageSeconds: 3600 }] : [], ...extra,
}) as unknown as DeploymentView;

function ledger(values: Record<string, number[]>, field: 'gpuEur' | 'cloudUsd' = 'gpuEur') {
  const n = Math.max(...Object.values(values).map(v => v.length));
  return {
    since: parisDay(NOW - (n - 1) * DAY),
    days: Array.from({ length: n }, (_, i) => ({
      day: parisDay(NOW - (n - 1 - i) * DAY),
      apps: Object.fromEntries(Object.entries(values).filter(([, v]) => v[i] !== undefined).map(([app, v]) => [app, { gpuEur: 0, requests: 0, tokens: 0, [field]: v[i]! }])),
    })),
  };
}

const input = (over: Partial<OverspendInput> = {}): OverspendInput => ({
  now: NOW, spend: null, gpus: [], keys: [], gpuSpend: null, machines: null, rows: [], appOf: d => d.app, ...over,
});

describe('overspend: GPU and cloud per app per day', () => {
  it('fires at 1.5× the usual day, using the larger of the last 7 days and the same weekday, so a class day is not news', () => {
    const tue = [3, 0.3, 0.3, 3, 3, 3, 3, 3, 0.3, 0.3, 3, 3, 3, 3];
    expect(findOverspend(input({ spend: ledger({ parle: [...tue, 3.2] }) }))).toEqual([]);
    const out = findOverspend(input({ spend: ledger({ parle: [...tue, 4.6] }), gpus: [gpu('speech-stack', 'parle', 0.79)] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: `gpu-day:parle:${parisDay(NOW)}`, kind: 'gpu-day', app: 'parle', value: 4.6, page: '/admin/gpus' });
    expect(out[0]!.normal).toBeCloseTo(3, 6);
    expect(out[0]!.text).toMatch(/1,5× o normal/);
  });

  it('projects the day with the €/h burning now until Paris midnight', () => {
    const [o] = findOverspend(input({ spend: ledger({ parle: [1, 1, 1, 6] }), gpus: [gpu('speech-stack', 'parle', 0.8)] }));
    expect(o!.projection).toMatch(/com €\s0,80\/h ligados agora, o dia fecha em ~€\s15,60/);
  });

  it('applies only the absolute floor with less than 3 days of history', () => {
    expect(findOverspend(input({ spend: ledger({ parle: [0.1, 4.9] }) }))).toEqual([]);
    const [o] = findOverspend(input({ spend: ledger({ parle: [0.1, 5] }) }));
    expect(o).toMatchObject({ normal: null, value: 5 });
    expect(o!.text).toMatch(/acima do piso de €\s5,00\/dia/);
  });

  it('ignores a big ratio on a tiny amount, and watches cloud US$ with the same rule', () => {
    expect(findOverspend(input({ spend: ledger({ parle: [0.1, 0.1, 0.1, 0.9] }) }))).toEqual([]);
    const [o] = findOverspend(input({ spend: ledger({ parle: [1, 1, 1, 2] }, 'cloudUsd') }));
    expect(o).toMatchObject({ kind: 'cloud-day', page: '/admin/gastos' });
    expect(o!.text).toMatch(/nuvem \(OpenRouter\) de parle hoje: US\$\s2,00/);
  });

  it('names the likely cause: an idle GPU, the key that started it, or the class window', () => {
    const idle = gpu('speech-stack', 'parle', 0.79, { lastRequestAt: new Date(NOW - 50 * 60_000).toISOString() });
    expect(findOverspend(input({ spend: ledger({ parle: [6] }), gpus: [idle] }))[0]!.cause).toMatch(/speech-stack ligada sem uso há 50 min/);
    const keys = [{ id: 'k1', user: 'parle-dev', label: 'agentes', active: true, lastUsedAt: null, policy: { gpuDailyEur: null } }];
    const gpuSpend = { spentEur: {}, running: [{ key: 'k1', deployment: 'speech-stack', until: new Date(NOW + 3_600_000).toISOString() }] };
    expect(findOverspend(input({ spend: ledger({ parle: [6] }), gpus: [gpu('speech-stack', 'parle', 0.79)], keys, gpuSpend }))[0]!.cause)
      .toMatch(/ligada pela chave parle-dev \(agentes\) até/);
  });
});

describe('overspend: caps hit before the day ends', () => {
  it('says when a key reaches its daily GPU cap at the current burn', () => {
    const keys = [{ id: 'k1', user: 'parle-dev', label: null, active: true, lastUsedAt: null, policy: { gpuDailyEur: 3 } }];
    const gpuSpend = { spentEur: { k1: 2 }, running: [{ key: 'k1', deployment: 'g', until: new Date(NOW + 9 * 3_600_000).toISOString() }] };
    const [o] = findOverspend(input({ keys, gpuSpend, gpus: [gpu('g', 'parle-dev', 0.5)] }));
    expect(o).toMatchObject({ kind: 'key-cap', who: 'chave parle-dev', urgent: false });
    expect(o!.projection).toMatch(/bate o teto às 14:00/);
    expect(findOverspend(input({ keys, gpuSpend, gpus: [gpu('g', 'parle-dev', 0.05)] }))).toEqual([]);
  });

  it('says when the machines fleet reaches its 24 h cap', () => {
    const machines = { global: { dayUsd: 8, capDayUsd: 10 }, machines: [{ status: 'running', usdPerHour: 1 }, { status: 'stopped', usdPerHour: 5 }] };
    const [o] = findOverspend(input({ machines }));
    expect(o).toMatchObject({ kind: 'machines-cap', app: null });
    expect(o!.projection).toMatch(/bate o teto às 14:00/);
  });
});

describe('overspend: calls per app per hour', () => {
  const rows = (perHourNow: number, usual: number): StoredTelemetryEvent[] => {
    const out: StoredTelemetryEvent[] = [];
    const push = (at: number) => out.push({ seq: out.length, rxTs: at, ts: at, source: 'gateway', level: 'info', event: 'route.served', traceId: '1'.repeat(32), app: 'parle' });
    for (let d = 7; d >= 1; d--) for (let i = 0; i < usual; i++) push(NOW - d * DAY - 30 * 60_000 + i);
    for (let i = 0; i < perHourNow; i++) push(NOW - 30 * 60_000 + i);
    return out.sort((a, b) => a.rxTs - b.rxTs);
  };

  it('compares the last hour with the same hour of the last 7 days', () => {
    expect(callSpikes(rows(300, 90), NOW).get('parle')).toEqual({ lastHour: 300, usual: 90 });
    const keys = [{ id: 'k1', user: 'parle', label: 'producao', active: true, lastUsedAt: new Date(NOW).toISOString(), policy: { gpuDailyEur: null } }];
    const [o] = findOverspend(input({ rows: rows(300, 90), keys }));
    expect(o).toMatchObject({ kind: 'calls-spike', app: 'parle', page: '/admin/servicos?app=parle#trafego' });
    expect(o!.cause).toMatch(/chave usada por último: parle \(producao\)/);
    expect(findOverspend(input({ rows: rows(250, 90) }))).toEqual([]);
    expect(findOverspend(input({ rows: rows(90, 10) }))).toEqual([]);
  });
});

describe('overspend watch', () => {
  function watch(spend: ReturnType<typeof ledger>, inClass = false) {
    const clock = { now: NOW };
    const state = { spend };
    const mails: AlertMail[] = [];
    const w = createOverspendWatch({
      input: () => ({ spend: state.spend, gpus: [], keys: [], gpuSpend: null, machines: null, rows: [], appOf: d => d.app }),
      notify: (_o, mail) => mails.push(mail), classOpen: () => inClass, baseUrl: 'https://gw.test', now: () => clock.now,
    });
    return { clock, state, mails, w };
  }
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('mails once, again within 6 h only at a new 2× step, and after 6 h only if it grew', async () => {
    const h = watch(ledger({ parle: [1, 1, 1, 2] }));
    h.w.check();
    await flush();
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]!.subject).toBe('gasto acima do normal: app parle');
    expect(h.mails[0]!.body).toContain('Ver: https://gw.test/admin/gpus');
    h.state.spend = ledger({ parle: [1, 1, 1, 3.9] });
    h.w.check();
    await flush();
    expect(h.mails).toHaveLength(1);
    h.state.spend = ledger({ parle: [1, 1, 1, 4] });
    h.w.check();
    await flush();
    expect(h.mails).toHaveLength(2);
    h.clock.now += 6 * 3_600_000;
    h.w.check();
    await flush();
    expect(h.mails).toHaveLength(2);
    h.state.spend = ledger({ parle: [1, 1, 1, 4.5] });
    h.w.check();
    await flush();
    expect(h.mails).toHaveLength(3);
    expect(h.w.active()).toHaveLength(1);
  });

  it('still mails during class, and says so', async () => {
    const h = watch(ledger({ parle: [1, 1, 1, 2] }), true);
    h.w.check();
    await flush();
    expect(h.mails[0]!.subject).toBe('gasto acima do normal: app parle (durante a aula)');
    expect(h.mails[0]!.body).toContain('durante a aula');
  });

  it('reads its thresholds from one place, env over defaults', () => {
    expect(overspendLimitsFromEnv({})).toEqual(OVERSPEND_DEFAULTS);
    expect(overspendLimitsFromEnv({ OVERSPEND_FACTOR: '2', OVERSPEND_FLOOR_EUR_DAY: '8', OVERSPEND_REPEAT_HOURS: '12', OVERSPEND_SPIKE_FACTOR: 'x' }))
      .toMatchObject({ factor: 2, floorEurDay: 8, repeatMs: 12 * 3_600_000, spikeFactor: OVERSPEND_DEFAULTS.spikeFactor });
    expect(dailyBaseline([{ day: '2026-10-12', value: 1 }], '2026-10-13', 3)).toBeNull();
  });
});

describe('overspend in the panel', () => {
  it('shows on the overview as an urgent item, and an app session sees only its own', () => {
    const s = demoSnapshot(NOW, 'bad');
    expect(s.overspend!.map(o => o.app)).toContain('parle');
    s.overspend!.push({ ...s.overspend![0]!, id: 'gpu-day:babelcast:x', app: 'babelcast', who: 'app babelcast' });
    const all = recommendations({ s, now: NOW, csrf: '', app: null, view: null });
    expect(all.filter(r => r.id.startsWith('overspend:')).map(r => r.level)).toEqual(['bad', 'bad']);
    expect(all.some(r => r.id === 'spend-trend:parle')).toBe(false);
    const own = recommendations({ s: scopeToApp(s, 'parle'), now: NOW, csrf: '', app: null, view: { id: 'parle', canPark: false } });
    expect(own.filter(r => r.id.startsWith('overspend:')).map(r => r.title)).toEqual(['Gasto acima do normal: app parle']);
  });
});
