import type { DeploymentView } from '../deployments/types';
import type { KeyView } from '../config/access-keys';
import { parisDay, parisMidnightAfter, type SpendDay, type SpendLedgerView } from '../deployments/spend-ledger';
import { idleGpu } from '../deployments/idle';
import { activeWindow } from '../deployments/autoscale';
import type { StoredTelemetryEvent } from './contract';
import type { AlertMail } from './alert-email';

export interface OverspendLimits {
  factor: number;
  floorEurDay: number;
  floorUsdDay: number;
  minEurDay: number;
  spikeFactor: number;
  spikeMinCalls: number;
  repeatMs: number;
  minHistoryDays: number;
}

export const OVERSPEND_DEFAULTS: OverspendLimits = {
  factor: 1.5, floorEurDay: 5, floorUsdDay: 5, minEurDay: 1, spikeFactor: 3, spikeMinCalls: 100, repeatMs: 6 * 3_600_000, minHistoryDays: 3,
};
export const OVERSPEND_CHECK_MS = 60_000;

const ENV: Record<keyof OverspendLimits, [string, number]> = {
  factor: ['OVERSPEND_FACTOR', 1], floorEurDay: ['OVERSPEND_FLOOR_EUR_DAY', 1], floorUsdDay: ['OVERSPEND_FLOOR_USD_DAY', 1], minEurDay: ['OVERSPEND_MIN_EUR_DAY', 1],
  spikeFactor: ['OVERSPEND_SPIKE_FACTOR', 1], spikeMinCalls: ['OVERSPEND_SPIKE_MIN_CALLS', 1], repeatMs: ['OVERSPEND_REPEAT_HOURS', 3_600_000],
  minHistoryDays: ['OVERSPEND_MIN_HISTORY_DAYS', 1],
};

export function overspendLimitsFromEnv(env: Record<string, string | undefined>): OverspendLimits {
  const out = { ...OVERSPEND_DEFAULTS };
  for (const [field, [name, scale]] of Object.entries(ENV) as Array<[keyof OverspendLimits, [string, number]]>) {
    const v = Number(env[name]?.trim());
    if (env[name]?.trim() && Number.isFinite(v) && v > 0) out[field] = v * scale;
  }
  return out;
}

export type OverspendKind = 'gpu-day' | 'cloud-day' | 'key-cap' | 'machines-cap' | 'calls-spike';

export interface Overspend {
  id: string;
  kind: OverspendKind;
  who: string;
  app: string | null;
  value: number;
  normal: number | null;
  text: string;
  projection: string;
  cause: string;
  action: string;
  page: string;
  urgent: boolean;
}

export interface OverspendInput {
  now: number;
  spend: SpendLedgerView | null;
  gpus: DeploymentView[];
  keys: Array<Pick<KeyView, 'id' | 'user' | 'label' | 'active' | 'lastUsedAt'> & { policy: Pick<KeyView['policy'], 'gpuDailyEur'> }>;
  gpuSpend: { spentEur: Record<string, number>; running?: Array<{ key: string; deployment: string; until: string }> } | null;
  machines: { global?: { dayUsd: number; capDayUsd: number }; machines: Array<{ status: string; usdPerHour: number | null }> } | null;
  rows: readonly StoredTelemetryEvent[];
  appOf: (d: DeploymentView) => string | null;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ZONE = 'Europe/Paris';
const fmt: Record<string, Intl.NumberFormat> = {};
export const money = (v: number, unit: '€' | 'US$' = '€') => (fmt[unit] ??= new Intl.NumberFormat('pt-BR', { style: 'currency', currency: unit === '€' ? 'EUR' : 'USD' })).format(v);
const hhmm = (ms: number) => new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(ms);
const times = (v: number, normal: number) => `${(v / normal).toFixed(1).replace('.', ',')}×`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const live = (d: DeploymentView) => d.replicas.filter(r => r.phase !== 'halted');
const perHourOf = (d: DeploymentView) => live(d).reduce((a, r) => a + (r.pricePerHour ?? 0), 0);

export function dailyBaseline(days: Array<{ day: string; value: number }>, today: string, minHistory: number): number | null {
  const past = days.filter(d => d.day < today).slice(-28);
  if (past.length < minHistory) return null;
  const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
  const same = past.filter(d => weekday(d.day) === weekday(today)).map(d => d.value);
  return Math.max(mean(past.slice(-7).map(d => d.value)), same.length ? mean(same) : 0);
}

function causeOf(input: OverspendInput, app: string): string {
  const mine = input.gpus.filter(d => input.appOf(d) === app && live(d).length);
  const idle = mine.map(d => ({ d, idle: idleGpu(d, input.now) })).find(x => x.idle);
  if (idle) return `${idle.d.name} ligada sem uso há ${Math.round(idle.idle!.minutes)} min`;
  const byKey = input.gpuSpend?.running?.find(r => mine.some(d => d.name === r.deployment));
  if (byKey) {
    const k = input.keys.find(x => x.id === byKey.key);
    return `${byKey.deployment} ligada pela chave ${k ? `${k.user}${k.label ? ` (${k.label})` : ''}` : byKey.key} até ${hhmm(Date.parse(byKey.until))}`;
  }
  const warm = mine.find(d => activeWindow(d.spec.warmSchedule, input.now));
  if (warm) return `${warm.name} aquecida pela janela de aula`;
  return mine.length ? `ligadas agora: ${mine.map(d => d.name).join(', ')}` : 'nenhuma GPU deste app ligada agora: o gasto já aconteceu hoje';
}

function dayRules(input: OverspendInput, limits: OverspendLimits): Overspend[] {
  if (!input.spend) return [];
  const today = parisDay(input.now);
  const hoursLeft = (parisMidnightAfter(input.now) - input.now) / HOUR_MS;
  const apps = new Set(input.spend.days.flatMap(d => Object.keys(d.apps)));
  const out: Overspend[] = [];
  for (const app of apps) {
    for (const [kind, field, unit, floor] of [['gpu-day', 'gpuEur', '€', limits.floorEurDay], ['cloud-day', 'cloudUsd', 'US$', limits.floorUsdDay]] as const) {
      const series = input.spend.days.filter(d => d.apps[app]).map(d => ({ day: d.day, value: (d.apps[app] as SpendDay)[field] ?? 0 }));
      const value = series.find(d => d.day === today)?.value ?? 0;
      const normal = dailyBaseline(series, today, limits.minHistoryDays);
      const overNormal = normal !== null && normal > 0 && value >= normal * limits.factor && value >= limits.minEurDay;
      if (!overNormal && value < floor) continue;
      const burn = kind === 'gpu-day' ? input.gpus.filter(d => input.appOf(d) === app).reduce((a, d) => a + perHourOf(d), 0) : 0;
      const label = kind === 'gpu-day' ? 'GPU' : 'nuvem (OpenRouter)';
      out.push({
        id: `${kind}:${app}:${today}`, kind, who: `app ${app}`, app, value, normal,
        text: `${label} de ${app} hoje: ${money(value, unit)}${normal ? ` (${times(value, normal)} o normal de ${money(normal, unit)}/dia)` : ` (acima do piso de ${money(floor, unit)}/dia)`}`,
        projection: burn ? `com ${money(burn)}/h ligados agora, o dia fecha em ~${money(value + burn * hoursLeft)} se nada desligar até a meia-noite` : `hoje até agora: ${money(value, unit)}`,
        cause: kind === 'gpu-day' ? causeOf(input, app) : 'mais pedidos de conversa na nuvem ou um modelo mais caro na reserva',
        action: kind === 'gpu-day' ? 'Estacione a GPU que ninguém usa (GPUs › Estacionar) ou confira a janela de aula' : 'Veja quem chama a conversa na nuvem e se a GPU deveria estar servindo',
        page: kind === 'gpu-day' ? '/admin/gpus' : '/admin/gastos', urgent: normal !== null && value >= normal * limits.factor * 2,
      });
    }
  }
  return out;
}

function capRules(input: OverspendInput): Overspend[] {
  const out: Overspend[] = [];
  const end = parisMidnightAfter(input.now);
  const price = new Map(input.gpus.map(d => [d.name, perHourOf(d)]));
  for (const k of input.keys.filter(k => k.active && k.policy.gpuDailyEur)) {
    const cap = k.policy.gpuDailyEur!;
    const spent = input.gpuSpend?.spentEur[k.id] ?? 0;
    const running = (input.gpuSpend?.running ?? []).filter(r => r.key === k.id);
    const burn = running.reduce((a, r) => a + (price.get(r.deployment) ?? 0), 0);
    if (!burn || spent >= cap) continue;
    const hitAt = input.now + ((cap - spent) / burn) * HOUR_MS;
    if (hitAt >= end) continue;
    const name = `${k.user}${k.label ? ` (${k.label})` : ''}`;
    out.push({
      id: `key-cap:${k.id}:${parisDay(input.now)}`, kind: 'key-cap', who: `chave ${name}`, app: k.user, value: spent, normal: cap,
      text: `chave ${name}: ${money(spent)} de GPU hoje, teto de ${money(cap)}/dia`,
      projection: `a ${money(burn)}/h bate o teto às ${hhmm(hitAt)}; depois disso não liga mais GPU até a meia-noite`,
      cause: `GPU ligada pela chave: ${running.map(r => r.deployment).join(', ')}`,
      action: 'Estacione a GPU se ninguém usa, ou suba o teto da chave (PUT /v1/admin/access/keys/policy)', page: '/admin/chaves', urgent: hitAt - input.now < 2 * HOUR_MS,
    });
  }
  const g = input.machines?.global;
  const burn = (input.machines?.machines ?? []).filter(m => m.status === 'running').reduce((a, m) => a + (m.usdPerHour ?? 0), 0);
  if (g && burn && g.dayUsd < g.capDayUsd) {
    const hitAt = input.now + ((g.capDayUsd - g.dayUsd) / burn) * HOUR_MS;
    if (hitAt < end) {
      out.push({
        id: 'machines-cap', kind: 'machines-cap', who: 'máquinas avulsas', app: null, value: g.dayUsd, normal: g.capDayUsd,
        text: `máquinas avulsas: ${money(g.dayUsd, 'US$')} em 24 h, teto de ${money(g.capDayUsd, 'US$')}`,
        projection: `a ${money(burn, 'US$')}/h bate o teto às ${hhmm(hitAt)}; depois disso nenhuma máquina nova liga`,
        cause: 'máquinas avulsas ligadas por agentes ou testes', action: 'Libere as máquinas que ninguém usa (GPUs e máquinas)', page: '/admin/gpus#maquinas',
        urgent: hitAt - input.now < 2 * HOUR_MS,
      });
    }
  }
  return out;
}

const ROUTE = new Set(['route.served', 'route.unavailable']);

export function callSpikes(rows: readonly StoredTelemetryEvent[], now: number): Map<string, { lastHour: number; usual: number }> {
  const counts = new Map<string, { byDay: number[]; day24: number }>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const age = now - row.rxTs;
    if (age > 8 * DAY_MS) break;
    if (age < 0 || !row.app || !ROUTE.has(row.event)) continue;
    const c = counts.get(row.app) ?? counts.set(row.app, { byDay: new Array<number>(8).fill(0), day24: 0 }).get(row.app)!;
    if (age < DAY_MS) c.day24++;
    if (age % DAY_MS < HOUR_MS) c.byDay[Math.floor(age / DAY_MS)]!++;
  }
  return new Map([...counts].map(([app, c]) => [app, { lastHour: c.byDay[0]!, usual: Math.max(...c.byDay.slice(1), (c.day24 - c.byDay[0]!) / 23) }]));
}

function spikeRules(input: OverspendInput, limits: OverspendLimits): Overspend[] {
  const out: Overspend[] = [];
  for (const [app, { lastHour, usual }] of callSpikes(input.rows, input.now)) {
    if (lastHour < limits.spikeMinCalls || lastHour < Math.max(1, usual) * limits.spikeFactor) continue;
    const key = input.keys.filter(k => k.user === app && k.lastUsedAt).sort((a, b) => b.lastUsedAt!.localeCompare(a.lastUsedAt!))[0];
    out.push({
      id: `calls-spike:${app}`, kind: 'calls-spike', who: `app ${app}`, app, value: lastHour, normal: usual,
      text: `${app}: ${lastHour} chamadas na última hora (${usual ? `${times(lastHour, usual)} o normal de ${Math.round(usual)}/h` : 'sem histórico nesta hora'})`,
      projection: `no ritmo atual, ~${Math.round(lastHour * 24)} chamadas em 24 h`,
      cause: `possível laço ou abuso${key ? `; chave usada por último: ${key.user}${key.label ? ` (${key.label})` : ''}` : ''}`,
      action: 'Confira o app; se for abuso, revogue a chave ou baixe o limite diário (PUT /v1/apps/<app>/limits)', page: `/admin/servicos?app=${encodeURIComponent(app)}#trafego`,
      urgent: lastHour >= Math.max(1, usual) * limits.spikeFactor * 2,
    });
  }
  return out;
}

export function findOverspend(input: OverspendInput, limits: OverspendLimits = OVERSPEND_DEFAULTS): Overspend[] {
  return [...dayRules(input, limits), ...capRules(input), ...spikeRules(input, limits)];
}

export function overspendMail(o: Overspend, opts: { baseUrl: string; inClass: boolean }): AlertMail {
  const subject = `gasto acima do normal: ${o.who}${opts.inClass ? ' (durante a aula)' : ''}`;
  return {
    kind: `spend.over|${o.id}`, level: o.urgent ? 'urgent' : 'warn', subject,
    body: [`${o.text}.`, `Projeção: ${o.projection}.`, `Causa provável: ${o.cause}.`, `O que fazer: ${o.action}.`, `Ver: ${opts.baseUrl}${o.page}`,
      ...(opts.inClass ? ['Isto acontece durante a aula.'] : [])].join('\n'),
  };
}

export function createOverspendWatch(opts: {
  input: () => Omit<OverspendInput, 'now'>;
  notify: (o: Overspend, mail: AlertMail) => unknown;
  classOpen: () => boolean;
  baseUrl: string;
  limits?: OverspendLimits;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}) {
  const now = opts.now ?? Date.now;
  const limits = opts.limits ?? OVERSPEND_DEFAULTS;
  const sent = new Map<string, { at: number; value: number }>();
  let active: Overspend[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  function check(): Overspend[] {
    const t = now();
    active = findOverspend({ ...opts.input(), now: t }, limits);
    const inClass = opts.classOpen();
    for (const o of active) {
      const last = sent.get(o.id);
      if (last && t - last.at < limits.repeatMs && o.value < last.value * 2) continue;
      if (last && t - last.at >= limits.repeatMs && o.value <= last.value) continue;
      sent.set(o.id, { at: t, value: o.value });
      void Promise.resolve().then(() => opts.notify(o, overspendMail(o, { baseUrl: opts.baseUrl, inClass }))).catch(() => {});
    }
    const open = new Set(active.map(o => o.id));
    for (const [id, s] of sent) if (!open.has(id) && t - s.at >= limits.repeatMs) sent.delete(id);
    return active;
  }

  return {
    check,
    active: () => active,
    start(intervalMs = OVERSPEND_CHECK_MS): void {
      if (timer) return;
      timer = setInterval(() => { try { check(); } catch (err) { opts.log?.('overspend: check failed', { error: String(err) }); } }, intervalMs);
      timer.unref?.();
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
  };
}
