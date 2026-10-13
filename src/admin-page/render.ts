import type { FallbackProbeResult } from '../telemetry/fallback-probe';
import type { BalanceReading } from '../telemetry/balance-watch';
import type { CreditIssue, DeploymentView } from '../deployments/types';
import type { KeyView } from '../config/access-keys';
import type { KeyAuditEntry } from '../config/key-audit';
import type { AppBudgetView } from '../gateway/proxy/app-limits';
import type { AppProfile } from '../deployments/apps';
import type { AppStatus } from '../deployments/app-gpu-health';
import { activeWindow } from '../deployments/autoscale';
import type { AdminTraffic, TrafficLine } from './traffic';
import { CSS } from './styles';

type Level = 'ok' | 'warn' | 'bad';

export interface AdminAlert { event: string; at: string; summary: string }

export interface AdminApp { id: string; profile: AppProfile | null; status: AppStatus | null; aliases?: string[] }

export interface AppView { id: string; canPark: boolean }

interface MachineCosts {
  global?: { dayUsd: number; committedUsd: number; capDayUsd: number };
  machines: Array<{ id: string; owner: string; holder: string | null; provider: string | null; status: string; usdPerHour: number | null; costUsd: number }>;
}

export interface AdminSnapshot {
  reserves: { intervalMinutes: number; links: FallbackProbeResult[] };
  balances: BalanceReading[];
  providerCredit: CreditIssue[];
  gpus: DeploymentView[] | null;
  gpuSpend: { spentEur: Record<string, number>; running?: Array<{ key: string; deployment: string; until: string; capEur: number | null }> } | null;
  alerts: AdminAlert[];
  machines: MachineCosts | null;
  keys: KeyView[];
  apps: AdminApp[];
  appBudgets: AppBudgetView[];
  traffic: AdminTraffic | null;
  audit: KeyAuditEntry[];
}

interface Section { id: string; title: string; level: Level; note: string; count: number | null; meta: string; actions: string; body: string }

interface Ctx { s: AdminSnapshot; now: number; csrf: string; app: string | null; view: AppView | null }

const ALERT_FRESH_MS = 60 * 60_000;
const NEAR_LIMIT = 0.8;
const ZONE = 'Europe/Paris';
const ACTIVITY_SHOWN = 30;

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const worst = (levels: Level[]): Level => (levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok');
const RANK: Record<Level, number> = { bad: 0, warn: 1, ok: 2 };
const byLevel = <T extends { level: Level }>(a: T, b: T) => RANK[a.level] - RANK[b.level];
const ratioLevel = (used: number, limit: number | null | undefined): Level => {
  if (!limit || limit <= 0) return 'ok';
  return used >= limit ? 'bad' : used >= limit * NEAR_LIMIT ? 'warn' : 'ok';
};
const CURRENCY: Record<string, Intl.NumberFormat> = {};
const money = (v: number | null | undefined, unit = '€') => {
  if (v === null || v === undefined) return '—';
  const code = unit === '€' ? 'EUR' : 'USD';
  CURRENCY[code] ??= new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code });
  return CURRENCY[code].format(v);
};
const count = (v: number) => new Intl.NumberFormat('pt-BR', { notation: v >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(v);
const pct = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 }).format(v);
const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2).replace('.', ',')} s` : `${count(Math.round(v))} ms`);
const latest = (dates: Array<string | null | undefined>) => dates.filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;
const hhmm = (iso: string | number) => new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(typeof iso === 'number' ? iso : Date.parse(iso));
const hour = (iso: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit' }).format(Date.parse(iso));

const ago = (iso: string | null, now: number) => {
  if (!iso) return 'nunca';
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  return min < 1 ? 'agora' : min < 120 ? `há ${min} min` : min < 2880 ? `há ${Math.round(min / 60)} h` : `há ${Math.round(min / 1440)} d`;
};
const when = (iso: string | null, now: number) => (iso ? `${hhmm(iso)}<small>${esc(ago(iso, now))}</small>` : 'nunca');
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
const duration = (seconds: number) => (seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1).replace('.', ',')} h`);

const LEVEL_TEXT: Record<Level, string> = { ok: 'Normal', warn: 'Atenção', bad: 'Problema' };
const GLYPH: Record<Level, string> = {
  ok: '<circle class="s" cx="10" cy="10" r="9"/><path class="g" d="m6 10.3 2.7 2.7L14 7.5"/>',
  warn: '<path class="s" d="M10 1.6 19.2 18H.8z"/><path class="g" d="M10 7.5v4.6m0 2.7v.1"/>',
  bad: '<path class="s" d="M6.3 1h7.4L19 6.3v7.4L13.7 19H6.3L1 13.7V6.3z"/><path class="g" d="m7 7 6 6m0-6-6 6"/>',
};
const mark = (level: Level) => `<span class="mark ${level}"><svg viewBox="0 0 20 20" aria-hidden="true">${GLYPH[level]}</svg><span class="sr">${LEVEL_TEXT[level]}:</span></span>`;
const pill = (level: Level, text: string) => `<span class="pill ${level}">${mark(level)}${esc(text)}</span>`;
const meter = (used: number, limit: number | null | undefined, level: Level) => (limit && limit > 0
  ? `<svg class="use ${level}" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="t" width="100" height="4"/><rect class="f" width="${Math.min(100, Math.round((used / limit) * 100))}" height="4"/></svg>`
  : '');
const form = (action: string, csrf: string, label: string, confirmText: string, fields: Record<string, string> = {}, cls = '') =>
  `<form method="post" action="${action}"${confirmText ? ` data-confirm="${esc(confirmText)}"` : ''}><input type="hidden" name="csrf" value="${csrf}">${
    Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')
  }<button${cls ? ` class="${cls}"` : ''}>${esc(label)}</button></form>`;

interface Col { label: string; num?: boolean; act?: boolean }

function table(cols: Col[], rows: string[][], empty: string): string {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  const cls = (c: Col) => (c.num ? ' class="n"' : c.act ? ' class="act"' : '');
  const head = cols.map(c => `<th${cls(c)}>${c.act ? `<span class="sr">${esc(c.label)}</span>` : esc(c.label)}</th>`).join('');
  const body = rows.map(r => `<tr>${r.map((cell, i) => `<td${cls(cols[i]!)} data-l="${esc(cols[i]!.label)}"><div class="v">${cell}</div></td>`).join('')}</tr>`).join('');
  return `<div class="tw"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const STAGE: Record<string, string> = { stt: 'Fala → texto', chat: 'Conversa', llm: 'Conversa', tts: 'Texto → fala', s2s: 'Fala → fala', translate: 'Tradução' };
const stageName = (stage: string) => STAGE[stage] ?? stage;

function reserves({ s, now, csrf, view }: Ctx): Section {
  const links = s.reserves.links;
  const failed = links.filter(r => !r.ok);
  const rows = [...links].sort((a, b) => Number(a.ok) - Number(b.ok)).map(r => [
    `<b>${esc(stageName(r.stage))}</b>`,
    `<code>${esc(r.target)}</code>${r.voice ? `<small>voz ${esc(r.voice)}</small>` : ''}`,
    r.ok ? pill('ok', 'respondeu') : `${pill('bad', `falhou${r.code ? ` · ${r.code}` : ''}`)}${r.error ? `<small class="err">${esc(r.error)}</small>` : ''}`,
    ms(r.latencyMs),
    when(r.checkedAt, now),
  ]);
  const level: Level = !links.length ? 'warn' : failed.length ? 'bad' : 'ok';
  const checked = latest(links.map(r => r.checkedAt));
  return {
    id: 'reservas', title: 'Reservas', level, count: links.length,
    note: !links.length ? 'nenhuma reserva testada ainda' : `${failed.map(r => stageName(r.stage)).join(', ')} sem resposta na nuvem`,
    meta: `teste a cada ${s.reserves.intervalMinutes} min${checked ? ` · último às ${hhmm(checked)}` : ''}`,
    actions: view ? '' : form('/admin/probe', csrf, 'Testar as reservas agora', 'Testar todas as reservas agora? Cada uma recebe um pedido mínimo real.'),
    body: table([{ label: 'Etapa' }, { label: 'Destino' }, { label: 'Resultado' }, { label: 'Latência', num: true }, { label: 'Verificado', num: true }], rows,
      `Nenhuma reserva testada ainda (o teste roda 30 s depois do boot e a cada ${s.reserves.intervalMinutes} min).`),
  };
}

const balanceLevel = (r: BalanceReading): Level => (r.level === 'ok' ? 'ok' : r.level === 'warn' ? 'warn' : 'bad');
const unitOf = (r: BalanceReading) => (r.currency === 'EUR' ? '€' : 'US$');

function balances({ s, now }: Ctx): Section {
  const credit = s.providerCredit.map(c => ({ level: 'bad' as Level, cells: [
    `<b>${esc(c.provider)}</b><small>${esc(c.message)}</small>`, pill('bad', 'sem crédito'), money(c.balanceUsd, 'US$'), '—', `piso ${money(c.floorUsd, 'US$')}`, '—',
  ] }));
  const readings = s.balances.map((r) => {
    const level = balanceLevel(r);
    const notes = [...r.reasons, r.error ? `erro: ${r.error}` : ''].filter(Boolean);
    const balance = r.balanceUsd !== null ? money(r.balanceUsd, unitOf(r))
      : r.monthEur !== null ? `${money(r.monthEur)}<small>de ${money(r.monthCapEur)} no mês</small>${meter(r.monthEur, r.monthCapEur, level)}` : '—';
    return { level, cells: [
      `<b>${esc(r.provider)}</b>${notes.length ? `<small>${esc(notes.join(' · '))}</small>` : ''}`,
      pill(level, LEVEL_TEXT[level]), balance, r.burnPerHour ? `${money(r.burnPerHour, unitOf(r))}/h` : '—',
      r.hoursLeft !== null ? `~${count(Math.round(r.hoursLeft))} h` : '—', when(r.checkedAt, now),
    ] };
  });
  const all = [...credit, ...readings].sort(byLevel);
  const level = worst(all.map(x => x.level));
  const checked = latest(s.balances.map(r => r.checkedAt));
  return {
    id: 'saldos', title: 'Saldos', level, count: all.length,
    note: [...s.providerCredit.map(c => `${c.provider} sem crédito`), ...s.balances.filter(r => r.level !== 'ok').map(r => `${r.provider}: ${r.reasons[0] ?? r.error ?? 'atenção'}`)].join(' · '),
    meta: checked ? `lidos às ${hhmm(checked)}` : 'ainda não lidos',
    actions: '',
    body: table([{ label: 'Provedor' }, { label: 'Estado' }, { label: 'Saldo', num: true }, { label: 'Ritmo', num: true }, { label: 'Autonomia', num: true }, { label: 'Lido', num: true }],
      all.map(x => x.cells), 'Nenhum saldo lido ainda.'),
  };
}

const GPU_STATUS: Record<string, string> = { ready: 'pronta', 'scaled-to-zero': 'desligada', warming: 'ligando', degraded: 'com falha', paused: 'pausada' };
const keyName = (k: KeyView | undefined) => (k ? `${k.user}${k.label ? ` (${k.label})` : ''}` : 'chave removida');
const upOf = (d: DeploymentView) => d.replicas.filter(r => r.phase !== 'halted');
const outsideWindow = (d: DeploymentView, now: number) => Boolean(d.spec.warmSchedule?.length) && upOf(d).length > 0 && !activeWindow(d.spec.warmSchedule, now);

function gpus({ s, now, csrf, view }: Ctx): Section {
  const base = { id: 'gpus', title: 'GPUs', actions: '' };
  if (!s.gpus) return { ...base, level: 'ok', note: '', count: null, meta: '', body: '<p class="empty">As GPUs gerenciadas estão desligadas neste gateway.</p>' };
  const keys = new Map(s.keys.map(k => [k.id, k]));
  const rows = s.gpus.map((d) => {
    const up = upOf(d);
    const outside = outsideWindow(d, now);
    const level: Level = d.status === 'degraded' || d.lastError ? 'warn' : outside ? 'warn' : 'ok';
    const perHour = up.reduce((sum, r) => sum + (r.pricePerHour ?? 0), 0);
    const ready = up.filter(r => r.phase === 'ready').length;
    const first = up[0];
    const by = [
      ...(s.gpuSpend?.running ?? []).filter(r => r.deployment === d.name).map(r => `${esc(keyName(keys.get(r.key)))} até ${hhmm(r.until)}`),
      d.warm ? `aquecida até ${hhmm(d.warm.until)}` : '',
      up.length && activeWindow(d.spec.warmSchedule, now) ? 'horário de aula' : '',
    ].filter(Boolean);
    const state = pill(level === 'ok' ? 'ok' : level, GPU_STATUS[d.status] ?? d.status)
      + (outside ? '<small>fora da janela de aula</small>' : '') + (d.lastError ? `<small class="err">${esc(d.lastError)}</small>` : '');
    return { level, cells: [
      `<b class="mono">${esc(d.name)}</b>${d.app ? `<small>app ${esc(d.app)}</small>` : ''}`,
      state,
      up.length ? `${ready}/${up.length}` : '0',
      first ? `${esc(first.machineType)}<small>${esc(first.zone)}</small>` : '—',
      up.length ? `${money(perHour)}/h` : '—',
      up.length ? duration(Math.max(...up.map(r => r.ageSeconds))) : '—',
      when(d.lastRequestAt, now),
      by.length ? by.join('<br>') : '—',
      up.length && (!view || (view.canPark && d.app === view.id)) ? form('/admin/park', csrf, 'Estacionar', `Estacionar ${d.name}? As réplicas sem uso desligam; pedidos em curso terminam.`, { name: d.name }, 'danger') : '',
    ] };
  }).sort(byLevel);
  const on = s.gpus.filter(d => upOf(d).length);
  const perHour = on.flatMap(upOf).reduce((sum, r) => sum + (r.pricePerHour ?? 0), 0);
  const level = worst(rows.map(r => r.level));
  return {
    ...base, level, count: s.gpus.length,
    note: s.gpus.filter(d => outsideWindow(d, now) || d.status === 'degraded' || d.lastError).map(d => `${d.name} ${outsideWindow(d, now) ? 'ligada fora da janela de aula' : GPU_STATUS[d.status] ?? d.status}`).join(' · '),
    meta: `${on.length} de ${s.gpus.length} ligadas · ${money(perHour)}/h agora`,
    body: table([
      { label: 'Deployment' }, { label: 'Estado' }, { label: 'Réplicas', num: true }, { label: 'Máquina' }, { label: 'Custo', num: true },
      { label: 'Ligada há', num: true }, { label: 'Último pedido', num: true }, { label: 'Ligada por' }, { label: 'Ação', act: true },
    ], rows.map(r => r.cells), 'Nenhuma GPU registrada.'),
  };
}

function alerts({ s, now }: Ctx): Section {
  const fresh = s.alerts.filter(a => now - Date.parse(a.at) < ALERT_FRESH_MS);
  const rows = s.alerts.slice(0, 20).map((a) => {
    const isFresh = now - Date.parse(a.at) < ALERT_FRESH_MS;
    return [when(a.at, now), `<code>${esc(a.event)}</code>${isFresh ? ` ${pill('warn', 'última hora')}` : ''}`, `<span class="mono">${esc(a.summary)}</span>`];
  });
  return {
    id: 'alertas', title: 'Avisos e alertas', level: fresh.length ? 'warn' : 'ok', count: s.alerts.length,
    note: `${plural(fresh.length, 'alerta', 'alertas')} na última hora`,
    meta: s.alerts[0] ? `último às ${hhmm(s.alerts[0].at)}` : 'desde o boot', actions: '',
    body: table([{ label: 'Quando' }, { label: 'Evento' }, { label: 'Detalhe' }], rows, 'Nenhum alerta desde o boot.'),
  };
}

function machines({ s }: Ctx): Section {
  const base = { id: 'maquinas', title: 'Máquinas avulsas', actions: '' };
  if (!s.machines) return { ...base, level: 'ok', note: '', count: null, meta: '', body: '<p class="empty">As máquinas avulsas estão desligadas neste gateway.</p>' };
  const live = s.machines.machines.filter(m => m.status === 'creating' || m.status === 'running');
  const g = s.machines.global;
  const level = g ? ratioLevel(g.dayUsd, g.capDayUsd) : 'ok';
  const stats = g ? `<div class="stats"><div><span>Gasto em 24 h</span><b>${money(g.dayUsd, 'US$')}</b></div><div><span>Teto de 24 h</span><b>${money(g.capDayUsd, 'US$')}</b></div>`
    + `<div><span>Reservado</span><b>${money(g.committedUsd, 'US$')}</b></div><div><span>Uso do teto</span><b>${pct(g.capDayUsd ? g.dayUsd / g.capDayUsd : 0)}</b>${meter(g.dayUsd, g.capDayUsd, level)}</div></div>` : '';
  const rows = live.map(m => [
    `<b class="mono">${esc(m.id)}</b>`, `${esc(m.owner)}${m.holder ? `<small>${esc(m.holder)}</small>` : ''}`, esc(m.provider ?? '—'),
    pill('ok', m.status === 'running' ? 'ligada' : 'ligando'), `${money(m.usdPerHour, 'US$')}/h`, money(m.costUsd, 'US$'),
  ]);
  return {
    ...base, level, count: live.length, note: g ? `gasto de 24 h em ${pct(g.dayUsd / g.capDayUsd)} do teto` : '',
    meta: `${live.length} ${live.length === 1 ? 'ligada' : 'ligadas'}`,
    body: stats + table([{ label: 'Máquina' }, { label: 'Dono' }, { label: 'Provedor' }, { label: 'Estado' }, { label: 'Custo', num: true }, { label: 'Gasto', num: true }],
      rows, 'Nenhuma máquina ligada.'),
  };
}

function gpuPolicy(k: KeyView): string {
  const p = k.policy;
  const wake = p.neverWake ? 'nunca acorda' : p.wakeDeployments.length ? `acorda só ${p.wakeDeployments.join(', ')}` : p.autoWake ? 'acorda sozinha' : 'não acorda sozinha';
  const extra = [p.wakeDeployments.length || p.neverWake ? '' : p.autoWakeOutsideClass ? 'fora da aula também' : 'só na aula', p.countsAsUse ? '' : 'não conta como uso'].filter(Boolean);
  return `${esc(wake)}${extra.length ? `<small>${esc(extra.join(' · '))}</small>` : ''}`;
}

function keys({ s, now }: Ctx): Section {
  const spent = s.gpuSpend?.spentEur ?? {};
  const active = s.keys.filter(k => k.active);
  const rows = active.map((k) => {
    const eur = spent[k.id] ?? 0;
    const cap = k.policy.gpuDailyEur;
    const level = ratioLevel(eur, cap);
    return { level, cells: [
      `<b>${esc(keyName(k))}</b>`, esc(k.role), k.source === 'env' ? 'variável' : 'emitida', gpuPolicy(k),
      `${money(eur)}<small>${cap === null ? 'sem teto' : `de ${money(cap)}/dia`}</small>${meter(eur, cap, level)}`,
      when(k.lastUsedAt, now),
    ] };
  });
  const removed = Object.entries(spent).filter(([id]) => !s.keys.some(k => k.id === id)).map(([, eur]) => ({ level: 'ok' as Level, cells: [
    '<b>chave removida</b>', '—', '—', '—', money(eur), '—',
  ] }));
  const all = [...rows, ...removed].sort(byLevel);
  const level = worst(all.map(r => r.level));
  return {
    id: 'chaves', title: 'Chaves', level, count: active.length, actions: '',
    note: active.filter(k => ratioLevel(spent[k.id] ?? 0, k.policy.gpuDailyEur) !== 'ok').map(k => `${keyName(k)} perto do teto diário de GPU`).join(' · '),
    meta: `${active.length} ativas · GPU hoje ${money(Object.values(spent).reduce((a, b) => a + b, 0))}`,
    body: table([{ label: 'Chave' }, { label: 'Papel' }, { label: 'Origem' }, { label: 'GPU' }, { label: 'GPU hoje', num: true }, { label: 'Último uso', num: true }],
      all.map(r => r.cells), 'Nenhuma chave ativa.'),
  };
}

const MODE: Record<string, { level: Level; text: string }> = {
  gpu: { level: 'ok', text: 'na GPU' }, degraded: { level: 'warn', text: 'na reserva de nuvem' }, down: { level: 'bad', text: 'fora do ar' },
};
const limitText = (v: number | null | undefined) => (v ? count(v) : '∞');

const KNOWN_APPS: Record<string, { name: string; description: string }> = {
  parle: { name: 'Parle', description: 'Jogo de português: o aluno conversa por voz com os personagens (fala → texto, conversa, texto → fala).' },
  babelcast: { name: 'Babelcast', description: 'Tradução simultânea: transcreve a fala ao vivo e a traduz em texto e voz.' },
};

const appTitle = (id: string, profile: AppProfile | null | undefined) => ({
  name: profile?.name || KNOWN_APPS[id]?.name || id, description: profile?.description || KNOWN_APPS[id]?.description || null,
});

function appCell(id: string, profile: AppProfile | null, needs: string): string {
  const { name, description } = appTitle(id, profile);
  return `<b><a href="/admin?app=${encodeURIComponent(id)}#apps">${esc(name)}</a></b>`
    + (name !== id ? ` <span class="mono">${esc(id)}</span>` : '')
    + `<small>${description ? esc(description) : 'sem descrição · defina em PUT /v1/apps/' + esc(id) + '/profile'}</small>`
    + `<small>${esc(needs)}</small>`;
}

function apps({ s, app: filter }: Ctx): Section {
  const ids = [...new Set([...s.apps.map(a => a.id), ...s.appBudgets.map(b => b.app)])].filter(id => !filter || id === filter).sort();
  const rows = ids.map((id) => {
    const app = s.apps.find(a => a.id === id);
    const budget = s.appBudgets.find(b => b.app === id);
    const mode = app?.status ? MODE[app.status.mode] : null;
    const reqLevel = budget ? ratioLevel(budget.requests.used, budget.requests.limit) : 'ok';
    const tokLevel = budget ? ratioLevel(budget.tokens.used, budget.tokens.limit) : 'ok';
    const level = worst([mode?.level ?? 'ok', reqLevel, tokLevel]);
    const profile = app?.profile ? `${app.profile.requiresGpu ? 'precisa de GPU' : 'GPU opcional'}${app.profile.gpuDeployments.length ? ` (${app.profile.gpuDeployments.join(', ')})` : ''}` : 'sem perfil';
    const deps = app?.status?.deployments.map(d => `<span class="mono">${esc(d.name)}</span> ${esc(GPU_STATUS[d.state] ?? d.state)} ${d.replicas.ready}/${d.replicas.total}`).join('<br>');
    return { id, level, mode, cells: [
      appCell(id, app?.profile ?? null, profile),
      pill(level, mode ? `servindo ${mode.text}` : LEVEL_TEXT[level]),
      deps || '—',
      budget ? `${count(budget.requests.used)}<small>de ${limitText(budget.requests.limit)}</small>${meter(budget.requests.used, budget.requests.limit, reqLevel)}` : '0',
      budget ? `${count(Math.round(budget.requests.perMinute * 10) / 10)}/min` : '—',
      budget ? `${count(budget.tokens.used)}<small>de ${limitText(budget.tokens.limit)}</small>${meter(budget.tokens.used, budget.tokens.limit, tokLevel)}` : '0',
      budget ? `${hhmm(budget.resetAt)}${budget.requests.exhaustedAt || budget.tokens.exhaustedAt ? '<small class="err">esgotou hoje</small>' : ''}` : '—',
    ] };
  }).sort(byLevel);
  const level = worst(rows.map(r => r.level));
  return {
    id: 'apps', title: 'Apps', level, count: ids.length, actions: '',
    note: rows.filter(r => r.level !== 'ok').map(r => `${r.id} ${r.mode ? `servindo ${r.mode.text}` : 'perto do limite do dia'}`).join(' · '),
    meta: 'pedidos e tokens contados desde a meia-noite',
    body: (filter ? `<p class="filter">Só o app <b>${esc(filter)}</b> · <a href="/admin#apps">ver todos</a></p>` : '')
      + table([{ label: 'App' }, { label: 'Estado' }, { label: 'GPU' }, { label: 'Pedidos hoje', num: true }, { label: 'Ritmo', num: true },
        { label: 'Tokens hoje', num: true }, { label: 'Zera às', num: true }], rows.map(r => r.cells), filter ? 'Nenhum app com esse nome.' : 'Nenhum app registrado.'),
  };
}

function chart(t: AdminTraffic): string {
  const H = 100;
  const max = Math.max(1, ...t.hours.map(h => h.served + h.failed));
  const bars = t.hours.map((h, i) => {
    const x = i * 20 + 2;
    const hs = Math.round((h.served / max) * H);
    const hf = h.failed ? Math.max(2, Math.round((h.failed / max) * H)) : 0;
    const label = `${hour(h.start)}h: ${plural(h.served, 'servida', 'servidas')}, ${count(h.failed)} sem resposta`;
    return `<g><title>${esc(label)}</title><rect class="hit" x="${i * 20}" y="0" width="20" height="${H}"/>${hs ? `<rect class="bs" x="${x}" y="${H - hs}" width="16" height="${hs}"/>` : ''}${
      hf ? `<rect class="bf" x="${x}" y="${H - hs - hf}" width="16" height="${hf}"/>` : ''}</g>`;
  }).join('');
  const busiest = t.hours.reduce((a, b) => (b.served + b.failed > a.served + a.failed ? b : a));
  const ticks = t.hours.map((h, i) => `<span>${i % 4 === 0 ? `${hour(h.start)}h` : ''}</span>`).join('');
  return `<div class="chart"><div class="cmax">pico ${count(max)}/h às ${hour(busiest.start)}h</div>`
    + `<svg viewBox="0 0 480 ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`Chamadas por hora nas últimas 24 h; pico de ${count(max)} às ${hour(busiest.start)}h`)}">`
    + `<line class="gl" x1="0" x2="480" y1="${H - 0.5}" y2="${H - 0.5}"/>${bars}</svg><div class="ticks">${ticks}</div>`
    + '<div class="legend"><span><i class="ls"></i>servidas</span><span><i class="lf"></i>sem resposta</span><span>horário de Paris</span></div></div>';
}

const lineCells = (l: TrafficLine, name: string, withFailed: boolean) => [
  name, count(l.served + l.failed), ...(withFailed ? [l.failed ? `<span class="err">${count(l.failed)}</span><small>${pct(l.failed / (l.served + l.failed))}</small>` : '0'] : []),
  count(l.fallbacks), ms(l.p50Ms), ms(l.p95Ms),
];

function traffic({ s }: Ctx): Section {
  const base = { id: 'trafego', title: 'Tráfego', actions: '' };
  const t = s.traffic;
  if (!t) return { ...base, level: 'ok', note: '', count: null, meta: '', body: '<p class="empty">A telemetria está desligada neste gateway: sem contagem de chamadas nem latência.</p>' };
  const lastHourFailed = t.hours.at(-1)?.failed ?? 0;
  const level: Level = lastHourFailed ? 'bad' : t.total.failed ? 'warn' : 'ok';
  const num = (label: string) => ({ label, num: true });
  return {
    ...base, level, count: null,
    note: lastHourFailed ? `${plural(lastHourFailed, 'chamada', 'chamadas')} sem resposta na última hora` : `${plural(t.total.failed, 'chamada', 'chamadas')} sem resposta em 24 h`,
    meta: 'últimas 24 h · telemetria do gateway',
    body: chart(t)
      + '<h3 class="sub">Por etapa</h3>'
      + table([{ label: 'Etapa' }, num('Chamadas'), num('Sem resposta'), num('Desvios p/ reserva'), num('p50'), num('p95')],
        t.stages.map(l => lineCells(l, `<b>${esc(stageName(l.key))}</b>`, true)), 'Nenhuma chamada nas últimas 24 h.')
      + '<h3 class="sub">Por provedor</h3>'
      + table([{ label: 'Provedor' }, num('Servidas'), num('Tentativas falhas'), num('p50'), num('p95')],
        t.providers.map(l => lineCells(l, `<code>${esc(l.key)}</code>`, false)), 'Nenhuma chamada nas últimas 24 h.'),
  };
}

const AUDIT_TEXT: Record<string, string> = {
  'admin-page.login': 'entrou no painel', 'admin-page.park': 'estacionou a GPU', 'admin-page.probe': 'testou as reservas',
  'deployment-credentials.rotate': 'trocou credenciais de máquina', 'provider-keys.applied': 'aplicou chaves de provedor',
  created: 'criou', updated: 'alterou', deleted: 'apagou', delete: 'apagou', start: 'ligou', stop: 'desligou', reboot: 'reiniciou',
};
const EVENT_TEXT: Record<string, string> = {
  'replica.creating': 'criando réplica', 'replica.ready': 'réplica pronta', 'replica.create_failed': 'falha ao criar réplica',
  'replica.unhealthy': 'réplica sem resposta', 'replica.parked': 'réplica estacionada', 'replica.power_on': 'religando réplica estacionada',
  'replica.released': 'réplica liberada', 'replica.gone': 'réplica sumiu no provedor', 'autoscale.warm': 'janela de aquecimento',
  'provider.credit_exhausted': 'provedor sem crédito', 'provider.credit_back': 'crédito de volta', 'stage.on_fallback': 'etapa foi para a reserva',
  'stage.on_primary': 'etapa voltou ao principal', 'app.degraded': 'app servindo pela reserva',
};
const TELEMETRY_LEVEL: Record<string, Level> = { error: 'bad', warn: 'warn' };
const TELEMETRY_TEXT: Record<string, string> = { error: 'erro', warn: 'aviso' };

function activity({ s, now }: Ctx): Section {
  const fromAudit = s.audit.map(e => ({ at: e.at, level: (e.ok ? 'ok' : 'bad') as Level, cells: [
    when(e.at, now), `<b>${esc(e.actor)}</b>`, esc(AUDIT_TEXT[e.action] ?? e.action),
    e.names.length ? `<span class="mono">${esc(e.names.join(', '))}</span>` : '—',
    e.ok ? pill('ok', 'feito') : `${pill('bad', 'falhou')}${e.detail ? `<small class="err">${esc(e.detail)}</small>` : ''}`,
  ] }));
  const fromGateway = (s.traffic?.activity ?? []).map((e) => {
    const level = TELEMETRY_LEVEL[e.level] ?? 'ok';
    return { at: e.at, level, cells: [
      when(e.at, now), 'gateway', esc(EVENT_TEXT[e.event] ?? e.event),
      `<span class="mono">${esc([e.deployment, e.replicaId].filter(Boolean).join(' · ') || '—')}</span>`, pill(level, TELEMETRY_TEXT[e.level] ?? 'info'),
    ] };
  });
  const all = [...fromAudit, ...fromGateway].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_SHOWN);
  const recentBad = all.filter(x => x.level !== 'ok' && now - Date.parse(x.at) < ALERT_FRESH_MS);
  return {
    id: 'atividade', title: 'Atividade', level: recentBad.length ? 'warn' : 'ok', count: null, actions: '',
    note: `${plural(recentBad.length, 'evento', 'eventos')} com falha na última hora`,
    meta: 'quem fez o quê: painel, chaves e ciclo das GPUs',
    body: table([{ label: 'Quando' }, { label: 'Quem' }, { label: 'O quê' }, { label: 'Alvo' }, { label: 'Resultado' }], all.map(x => x.cells), 'Nenhuma atividade registrada.'),
  };
}

function sections(ctx: Ctx): Section[] {
  if (ctx.view) return [apps(ctx), gpus(ctx), reserves(ctx), keys(ctx), alerts(ctx), activity(ctx)];
  return [traffic(ctx), apps(ctx), gpus(ctx), reserves(ctx), balances(ctx), keys(ctx), machines(ctx), alerts(ctx), activity(ctx)];
}

interface Kpi { label: string; href: string; value: string; sub: string; level: Level | null }

function kpis({ s, view }: Ctx, all: Section[]): Kpi[] {
  const t = s.traffic;
  const total = t ? t.total.served + t.total.failed : 0;
  const levelOf = (id: string) => all.find(x => x.id === id)?.level ?? null;
  const on = (s.gpus ?? []).filter(d => upOf(d).length);
  const perHour = on.flatMap(upOf).reduce((sum, r) => sum + (r.pricePerHour ?? 0), 0);
  const keySpend = Object.values(s.gpuSpend?.spentEur ?? {}).reduce((a, b) => a + b, 0);
  const g = s.machines?.global;
  const shortest = s.balances.filter(r => r.balanceUsd !== null).sort((a, b) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity))[0];
  const reservesOk = s.reserves.links.filter(r => r.ok).length;
  const calls: Kpi[] = view ? [] : [
    { label: 'Chamadas 24 h', href: '#trafego', value: t ? count(total) : '—', sub: t ? `${count(t.hours.at(-1)!.served + t.hours.at(-1)!.failed)} na última hora` : 'telemetria desligada', level: null },
    { label: 'Sem resposta 24 h', href: '#trafego', value: t ? count(t.total.failed) : '—', sub: t ? `${pct(total ? t.total.failed / total : 0)} · ${plural(t.total.fallbacks, 'desvio', 'desvios')}` : 'telemetria desligada', level: levelOf('trafego') },
    { label: 'Latência p95', href: '#trafego', value: ms(t?.total.p95Ms), sub: t ? `p50 ${ms(t.total.p50Ms)} · 24 h` : 'telemetria desligada', level: null },
  ];
  return [
    ...calls,
    { label: 'GPUs ligadas', href: '#gpus', value: s.gpus ? `${on.length} de ${s.gpus.length}` : '—', sub: s.gpus ? `${money(perHour)}/h agora` : 'GPUs desligadas aqui', level: levelOf('gpus') },
    { label: 'Gasto GPU hoje', href: '#chaves', value: money(keySpend), sub: g ? `máquinas ${money(g.dayUsd, 'US$')}/24 h` : 'pedida por chaves', level: null },
    shortest
      ? { label: 'Menor saldo', href: '#saldos', value: `${money(shortest.balanceUsd, unitOf(shortest))}`, sub: `${shortest.provider}${shortest.hoursLeft !== null ? ` · ~${count(Math.round(shortest.hoursLeft))} h` : ''}`, level: levelOf('saldos') }
      : { label: 'Reservas', href: '#reservas', value: `${reservesOk} de ${s.reserves.links.length}`, sub: 'respondendo', level: levelOf('reservas') },
  ];
}

const HEADLINE: Record<Level, string> = { ok: 'Tudo funcionando', warn: 'Funcionando, com avisos', bad: 'Algo está fora do ar' };
const LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h10M4 17h6"/><circle cx="18" cy="15" r="3"/></svg>';

const NAV_JS = `var l=document.getElementById('login');if(l)l.addEventListener('submit',function(){l.next.value+=location.hash});`
  + `document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!confirm(f.dataset.confirm))e.preventDefault()})});`
  + `var links=document.querySelectorAll('.nav a');if(links.length&&'IntersectionObserver' in window){var o=new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting)return;`
  + `links.forEach(function(a){var on=a.getAttribute('href')==='#'+e.target.id;a.classList.toggle('cur',on);if(on)a.setAttribute('aria-current','true');else a.removeAttribute('aria-current')})})},{rootMargin:'-20% 0px -70% 0px'});`
  + `document.querySelectorAll('[data-spy]').forEach(function(s){o.observe(s)})}`;

function page(nonce: string, title: string, body: string, refresh = false): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    refresh ? '<meta http-equiv="refresh" content="60">' : ''}<meta name="robots" content="noindex"><title>${esc(title)}</title><style nonce="${nonce}">${CSS}</style></head><body>${body}`
    + `<script nonce="${nonce}">${NAV_JS}</script></body></html>`;
}

export function renderLogin(nonce: string, error: string | null, next = '/admin'): string {
  return page(nonce, 'ai-gateway · entrar', `<main class="login"><div class="brand">${LOGO}<span>ai-gateway <small>admin</small></span></div>`
    + `<section><h1>Painel do gateway</h1><p>Cole a chave admin, ou a chave do seu app para ver só os dados dele; a sessão dura 12 h neste aparelho.</p>${
    error ? `<p class="msg" role="alert">${mark('bad')}${esc(error)}</p>` : ''}<form method="post" action="/admin/login" id="login"><input type="hidden" name="next" value="${esc(next)}"><label for="key">Chave admin ou do app</label>`
    + '<input id="key" name="key" type="password" autocomplete="current-password" required autofocus><button>Entrar</button></form></section></main>');
}

export function renderStatus(nonce: string, s: AdminSnapshot, opts: { now: number; csrf: string; actor: string; message: string | null; app: string | null; view?: AppView | null }): string {
  const view = opts.view ?? null;
  const ctx: Ctx = { s, now: opts.now, csrf: opts.csrf, app: view ? null : opts.app, view };
  const own = view && appTitle(view.id, s.apps.find(a => a.id === view.id)?.profile);
  const brand = `<div class="brand">${LOGO}<span>ai-gateway <small>${own ? 'app' : 'admin'}</small></span></div>`;
  const all = sections(ctx);
  const overall = worst(all.map(x => x.level));
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(opts.now);
  const nav = [`<li><a href="#visao" class="${overall}">${mark(overall)}Visão geral</a></li>`, ...all.map(x =>
    `<li><a href="#${x.id}" class="${x.level}">${mark(x.level)}${esc(x.title)}${x.count !== null ? `<span class="n">${x.count}</span>` : ''}</a></li>`)].join('');
  const side = `<aside class="side">${brand}<ul class="nav" aria-label="Seções">${nav}</ul>`
    + `<div class="foot"><div class="who"><b>${esc(opts.actor)}</b><br>atualizado às ${time}<br>recarrega a cada 1 min</div>${form('/admin/logout', opts.csrf, 'Sair', '')}</div></aside>`;
  const attention = all.filter(x => x.level !== 'ok').sort(byLevel);
  const attn = attention.length
    ? `<ul class="attn" aria-label="Pedem atenção">${attention.map(x => `<li>${mark(x.level)}<a href="#${x.id}">${esc(x.title)}</a><span class="t">${esc(x.note)}</span></li>`).join('')}</ul>`
    : '';
  const tiles = kpis(ctx, all).map(k => `<a class="kpi" href="${k.href}"><span class="kl">${k.level ? mark(k.level) : ''}${esc(k.label)}</span><b>${k.value}</b><small>${esc(k.sub)}</small></a>`).join('');
  const overview = `<div id="visao" data-spy><div class="top">${mark(overall)}<div><h1>${HEADLINE[overall]}</h1><p>${
    attention.length ? `${attention.length} ${attention.length > 1 ? 'áreas pedem' : 'área pede'} atenção` : `As ${all.length} áreas estão normais`} · ${time} (Paris)</p></div></div>`
    + (own ? `<p class="scope">Visão do app <b>${esc(own.name)}</b>${own.description ? ` · ${esc(own.description)}` : ''}<small>Só os dados deste app: as GPUs, as chaves, as reservas e os eventos dele.</small></p>` : '')
    + `${attn}<div class="kpis${view ? ' few' : ''}">${tiles}</div></div>`;
  const body = all.map(x => `<section id="${x.id}" data-spy><header class="sh"><h2>${esc(x.title)}</h2>${pill(x.level, LEVEL_TEXT[x.level])}${
    x.meta ? `<span class="meta">${esc(x.meta)}</span>` : ''}${x.actions ? `<div class="acts">${x.actions}</div>` : ''}</header>${x.body}</section>`).join('');
  return page(nonce, `ai-gateway · ${own ? `${own.name} · ` : ''}${HEADLINE[overall]}`, `<div class="shell">${side}<main class="main">${
    opts.message ? `<p class="msg" role="status">${esc(opts.message)}</p>` : ''}${overview}${body}</main></div>`, true);
}
