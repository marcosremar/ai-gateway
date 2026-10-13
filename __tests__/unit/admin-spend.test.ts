import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SpendLedger, parisDay, parisMidnightAfter } from '../../src/deployments/spend-ledger';
import type { DeploymentView } from '../../src/deployments/types';
import { recommendations, scopeToApp, type AdminSnapshot } from '../../src/admin-page';
import { PAGES, renderStatus } from '../../src/admin-page/pages';
import { monthForecast } from '../../src/admin-page/spend';
import { eurPerHourNow, eurPerMonth } from '../../src/admin-page/recommendations';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

const gpu = (name: string, app: string | null, eurPerHour: number, ageMinutes: number) => ({
  name, app, replicas: [{ id: `${name}-r`, phase: 'ready', pricePerHour: eurPerHour, ageSeconds: ageMinutes * 60 }],
}) as unknown as DeploymentView;

async function ledgerAt(start: string, deployments: DeploymentView[], path?: string) {
  const clock = { now: Date.parse(start) };
  const owners: Record<string, string> = { 'babel-live': 'babelcast' };
  const ledger = new SpendLedger({ path, now: () => clock.now, deployments: () => deployments, ownerOf: d => d.app ?? owners[d.name] ?? null });
  await ledger.load();
  return { clock, ledger };
}

const at = (ledger: SpendLedger, day: string, app: string) => ledger.view().days.find(d => d.day === day)?.apps[app];

describe('spend ledger', () => {
  it('finds Paris midnight in summer and winter time', () => {
    expect(new Date(parisMidnightAfter(Date.parse('2026-07-01T12:00:00Z'))).toISOString()).toBe('2026-07-01T22:00:00.000Z');
    expect(new Date(parisMidnightAfter(Date.parse('2026-12-01T12:00:00Z'))).toISOString()).toBe('2026-12-01T23:00:00.000Z');
    expect(parisDay(Date.parse('2026-10-13T22:30:00Z'))).toBe('2026-10-14');
  });

  it('charges each replica its €/h to the app that owns the deployment, from the profile when the deployment names none', async () => {
    const { clock, ledger } = await ledgerAt('2026-10-13T10:00:00Z', [gpu('speech-stack', 'parle', 0.8, 30), gpu('babel-live', null, 0.4, 600)]);
    ledger.accrue();
    expect(at(ledger, '2026-10-13', 'parle')?.gpuEur).toBeCloseTo(0.4, 6);
    expect(at(ledger, '2026-10-13', 'babelcast')?.gpuEur).toBeCloseTo(0.4 * 10, 6);
    clock.now += 15 * 60_000;
    ledger.accrue();
    expect(at(ledger, '2026-10-13', 'parle')?.gpuEur).toBeCloseTo(0.6, 6);
    ledger.request('parle', 120);
    ledger.request('parle');
    expect(at(ledger, '2026-10-13', 'parle')).toMatchObject({ requests: 2, tokens: 120 });
  });

  it('backfills the first day only from today, never before the ledger existed', async () => {
    const { ledger } = await ledgerAt('2026-10-13T01:00:00Z', [gpu('speech-stack', 'parle', 1, 600)]);
    ledger.accrue();
    expect(ledger.view().days.map(d => d.day)).toEqual(['2026-10-13']);
    expect(at(ledger, '2026-10-13', 'parle')?.gpuEur).toBeCloseTo(3, 6);
    expect(ledger.view().since).toBe('2026-10-13');
  });

  it('splits a tick that crosses Paris midnight between the two days', async () => {
    const { clock, ledger } = await ledgerAt('2026-10-13T21:30:00Z', [gpu('speech-stack', 'parle', 1, 600)]);
    ledger.accrue();
    clock.now = Date.parse('2026-10-13T22:30:00Z');
    ledger.accrue();
    expect(at(ledger, '2026-10-13', 'parle')?.gpuEur).toBeCloseTo(10.5, 6);
    expect(at(ledger, '2026-10-14', 'parle')?.gpuEur).toBeCloseTo(0.5, 6);
    ledger.request('parle');
    expect(at(ledger, '2026-10-14', 'parle')?.requests).toBe(1);
  });

  it('keeps 90 days and drops older ones', async () => {
    const { clock, ledger } = await ledgerAt('2026-07-01T10:00:00Z', []);
    for (let i = 0; i < 100; i++) {
      ledger.request('parle');
      ledger.accrue();
      clock.now += 86_400_000;
    }
    const days = ledger.view().days.map(d => d.day);
    expect(days).toHaveLength(90);
    expect(days[0]).toBe(parisDay(clock.now - 90 * 86_400_000));
  });

  it('survives a restart: reloads the file and charges the downtime only for replicas that kept running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spend-'));
    dirs.push(dir);
    const path = join(dir, 'spend-ledger.json');
    const first = await ledgerAt('2026-10-13T10:00:00Z', [gpu('speech-stack', 'parle', 1, 60)], path);
    first.ledger.request('parle', 50);
    await first.ledger.stop();
    const second = await ledgerAt('2026-10-13T12:00:00Z', [gpu('speech-stack', 'parle', 1, 30)], path);
    expect(at(second.ledger, '2026-10-13', 'parle')).toMatchObject({ gpuEur: 1, requests: 1, tokens: 50 });
    second.ledger.accrue();
    expect(at(second.ledger, '2026-10-13', 'parle')?.gpuEur).toBeCloseTo(1.5, 6);
    await second.ledger.dismiss('gpu-idle:speech-stack');
    const third = await ledgerAt('2026-10-14T12:00:00Z', [], path);
    expect(Object.keys(third.ledger.dismissed())).toEqual(['gpu-idle:speech-stack']);
    third.clock.now += 7 * 86_400_000;
    expect(third.ledger.dismissed()).toEqual({});
  });

  it('adds the cloud cost the upstream reported to the app of the key, and ignores nonsense', async () => {
    const { ledger } = await ledgerAt('2026-10-13T10:00:00Z', []);
    ledger.cloud('parle', 0.0012);
    ledger.cloud('parle', 0.0008);
    ledger.cloud('parle', Number.NaN);
    ledger.cloud('parle', -1);
    expect(at(ledger, '2026-10-13', 'parle')).toMatchObject({ cloudUsd: 0.002, requests: 0 });
  });

  it('starts empty when the file is missing and refuses a corrupt one without backup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spend-'));
    dirs.push(dir);
    const path = join(dir, 'spend-ledger.json');
    expect((await ledgerAt('2026-10-13T10:00:00Z', [], path)).ledger.view()).toEqual({ since: null, days: [] });
    await writeFile(path, '{oops');
    await expect(ledgerAt('2026-10-13T10:00:00Z', [], path)).rejects.toThrow(/unreadable/);
  });
});

const NOW = Date.parse('2026-10-13T10:00:00Z');
const render = (s: AdminSnapshot, view: { id: string; canPark: boolean } | null = null) =>
  PAGES.map(p => renderStatus('n', s, { now: NOW, csrf: 'c', actor: view?.id ?? 'marcos', message: null, app: null, view, page: p.id })).join('');
const section = (html: string, id: string) => html.slice(html.indexOf(`<section id="${id}"`), html.indexOf('</section>', html.indexOf(`<section id="${id}"`)));

describe('spend chart', () => {
  it('draws 30 days of stacked bars per app with names, a total per day and today / 7 / 30-day sums', () => {
    const html = render(demoSnapshot(NOW, 'warn'));
    const spend = section(html, 'gastos');
    expect(spend).toContain('<h2>Gasto por dia</h2>');
    expect(spend.match(/<g><title>/g)).toHaveLength(30);
    expect(spend).toMatch(/<title>13\/10: total GPU [^<]*— Parle [^<]*; Babelcast /);
    expect(spend).toContain('<i class="c0"></i>Parle');
    for (const col of ['Hoje', '7 dias', '30 dias']) expect(spend).toContain(`>${col}<`);
    expect(spend).toMatch(/€\s[\d,]+<small>nuvem US\$\s[\d,]+ · [\d.]+ pedidos<\/small><small>US\$\s[\d,]+ estimado<\/small>/);
    expect(spend).toContain('usage.cost');
    expect(spend).toContain('Mês até agora');
    expect(spend).toContain('Projeção até 31/10');
    expect(html.indexOf('id="recomendacoes"')).toBeLessThan(html.indexOf('id="trafego"'));
    expect(html).toContain('href="#gastos"');
  });

  it('leaves the days before the ledger empty and says when it started', () => {
    const s = demoSnapshot(NOW, 'ok');
    s.spend = { since: '2026-10-12', days: s.spend!.days.slice(-2) };
    const spend = section(render(s), 'gastos');
    expect(spend.match(/— sem registro<\/title>/g)).toHaveLength(28);
    expect(spend).toContain('registro desde 12/10');
  });

  it('shows an app session only its own series', () => {
    const html = render(scopeToApp(demoSnapshot(NOW, 'bad'), 'parle'), { id: 'parle', canPark: false });
    const spend = section(html, 'gastos');
    expect(spend).toContain('Parle');
    expect(spend).not.toMatch(/babel/i);
    expect(html).not.toMatch(/babel/i);
  });
});

describe('month forecast', () => {
  const day = (d: string, gpuEur: number, cloudUsd = 0) => ({ day: d, apps: { parle: { gpuEur, requests: 1, tokens: 0, cloudUsd } } });
  const ctxAt = (now: string, days: ReturnType<typeof day>[], since = days[0]!.day) =>
    ({ s: { ...demoSnapshot(NOW, 'ok'), spend: { since, days } }, now: Date.parse(now), csrf: 'c', app: null, view: null });

  it('adds what was spent to what the same weekday cost in the last 4 weeks, for every day left in the month', () => {
    const days = [];
    for (let i = 1; i <= 30; i++) {
      const d = `2026-09-${String(i).padStart(2, '0')}`;
      const weekday = new Date(`${d}T12:00:00Z`).getUTCDay();
      days.push(day(d, weekday >= 1 && weekday <= 4 ? 4 : 1, 0.5));
    }
    days.push(day('2026-10-01', 4, 0.5), day('2026-10-02', 0.5, 0.1));
    const f = monthForecast(ctxAt('2026-10-02T09:00:00Z', days))!;
    expect(f.month).toBe('2026-10');
    expect(f.lastDay).toBe('2026-10-31');
    expect(f.sofar).toEqual({ gpuEur: 4.5, cloudUsd: 0.6 });
    const classDays = [...Array(31).keys()].map(i => new Date(Date.UTC(2026, 9, i + 1)).getUTCDay()).filter(w => w >= 1 && w <= 4).length;
    expect(f.projected.gpuEur).toBeCloseTo(classDays * 4 + (31 - classDays) * 1, 6);
    expect(f.projected.cloudUsd).toBeCloseTo(0.5 * 31, 6);
    expect(f.basis).toBe('weekday');
  });

  it('projects only what was spent when there is no history, and nothing without a ledger', () => {
    const f = monthForecast(ctxAt('2026-10-13T09:00:00Z', [day('2026-10-13', 2)]))!;
    expect(f).toMatchObject({ sofar: { gpuEur: 2 }, projected: { gpuEur: 2 }, basis: 'none' });
    expect(monthForecast({ ...ctxAt('2026-10-13T09:00:00Z', [day('2026-10-13', 2)]), s: { ...demoSnapshot(NOW, 'ok'), spend: null } })).toBeNull();
  });
});

describe('recommendations', () => {
  const ctx = (s: AdminSnapshot, view: { id: string; canPark: boolean } | null = null) => ({ s, now: NOW, csrf: 'c', app: null, view });
  const ids = (s: AdminSnapshot) => recommendations(ctx(s)).map(r => r.id);
  const quiet = (): AdminSnapshot => {
    const s = demoSnapshot(NOW, 'ok');
    return {
      ...s, traffic: null, spend: null, ttsCache: null, balances: s.balances.map(b => ({ ...b, hoursLeft: b.hoursLeft === null ? null : 500 })),
      keys: s.keys.map(k => ({ ...k, policy: { ...k.policy, gpuDailyEur: k.policy.gpuDailyEur ?? 20 } })),
      apps: s.apps.map(a => ({ ...a, profile: { requiresGpu: false, gpuDeployments: [], ...a.profile, name: a.id, description: 'x' } })),
      appBudgets: [],
      gpus: s.gpus!.map(d => ({ ...d, replicas: [], lastRequestAt: new Date(NOW).toISOString(), spec: { ...d.spec, idleMinutes: 10 } })) as DeploymentView[],
    };
  };

  it('stays quiet without data that triggers a rule', () => {
    expect(ids(quiet())).toEqual([]);
    expect(section(render(quiet()), 'recomendacoes')).toContain('Nada a fazer agora');
  });

  it('fires each rule on its own data', () => {
    const base = demoSnapshot(NOW, 'warn');
    const warn = ids(base);
    for (const id of ['gpu-outside:speech-stack', 'idle-tail:speech-stack', 'keycap-none:parle.producao', 'balance-low:vast', 'deployment-unused:parle-bridge-shadow',
      'app-unnamed:babelcast', 'spend-trend:parle', 'turn-latency']) expect(warn).toContain(id);

    const s = quiet();
    s.gpus![3] = { ...base.gpus![3]!, lastRequestAt: new Date(NOW - 45 * 60_000).toISOString() };
    s.reserves.links[0] = { ...s.reserves.links[0]!, ok: false, code: 'upstream_error' };
    s.gpuSpend = { spentEur: { 'key-0f3a9c11d2e4': 2.9 } };
    s.keys = s.keys.map(k => (k.id === 'key-0f3a9c11d2e4' ? { ...k, policy: { ...k.policy, gpuDailyEur: 3 } } : k));
    s.apps[0] = { ...base.apps[0]!, profile: { ...base.apps[0]!.profile!, name: 'Parle', description: 'x' }, status: { ...base.apps[0]!.status!, mode: 'degraded' } };
    s.gpus![0] = base.gpus![0]!;
    s.appBudgets = [{ ...base.appBudgets[1]!, requests: { ...base.appBudgets[1]!.requests, used: 1700 } }];
    s.traffic = { ...base.traffic!, stages: [{ key: 'tts', served: 40, failed: 0, fallbacks: 30, p50Ms: 600, p95Ms: 2400 }] };
    s.balances = s.balances.map(b => (b.provider === 'scaleway' ? { ...b, monthEur: 150 } : b));
    expect(ids(s)).toEqual(expect.arrayContaining(['gpu-idle:babel-live', 'reserve-failed:stt:openrouter:openai/whisper-large-v3', 'keycap-near:parle-dev.agentes',
      'app-degraded-gpu:parle', 'stage-p95:tts', 'stage-fallback:tts', 'app-budget:babelcast:pedidos', 'month-pace:scaleway']));
  });

  it('orders what burns money now first, then the monthly saving, then the rest', () => {
    const list = recommendations(ctx(demoSnapshot(NOW, 'warn')));
    const now = list.map(eurPerHourNow);
    expect(now.filter(Boolean).length).toBeGreaterThan(1);
    expect(now).toEqual([...now].sort((a, b) => b - a));
    const monthly = list.filter(r => !eurPerHourNow(r)).map(eurPerMonth);
    expect(monthly.filter(Boolean).length).toBeGreaterThan(1);
    expect(monthly).toEqual([...monthly].sort((a, b) => b - a));
  });

  it('shows an app session only its own recommendations, with no admin-only action', () => {
    const scoped = scopeToApp(demoSnapshot(NOW, 'bad'), 'parle');
    const list = recommendations(ctx(scoped, { id: 'parle', canPark: false }));
    expect(list.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toMatch(/babel|vast|openrouter:openai\/gpt|parle-dev|agentes/);
    const html = section(render(scoped, { id: 'parle', canPark: false }), 'recomendacoes');
    expect(html).not.toContain('/admin/dismiss');
    expect(html).not.toContain('/admin/probe');
    expect(html).not.toContain('/admin/park');
  });

  it('puts the recommendations that need action on the overview and folds the tidy-up ones', () => {
    const html = renderStatus('n', demoSnapshot(NOW, 'warn'), { now: NOW, csrf: 'c', actor: 'marcos', message: null, app: null });
    const list = section(html, 'recomendacoes');
    expect(list).toContain('<h2>O que fazer</h2>');
    expect(list.indexOf('speech-stack ligada fora da janela de aula')).toBeLessThan(list.indexOf('<details class="more"'));
    expect(list.slice(list.indexOf('<details class="more"'))).toContain('parle-bridge-shadow sem uso');
    expect(list).toContain('<a class="btn" href="/admin/gastos">Ver os gastos por dia</a>');
  });

  it('shows build, uptime, region and freshness in the status bar', () => {
    const bar = /<footer class="bar"[^]*?<\/footer>/.exec(render(demoSnapshot(NOW, 'warn')))![0];
    for (const text of ['build <code>0a52749</code>', 'no ar há', 'região europe-west4', 'telemetria agora', 'saldos há 6 min', 'reservas há 4 min']) expect(bar).toContain(text);
  });
});
