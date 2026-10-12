import type { FallbackProbeResult } from '../telemetry/fallback-probe';
import type { BalanceReading } from '../telemetry/balance-watch';
import type { CreditIssue, DeploymentView } from '../deployments/types';
import type { KeyView } from '../config/access-keys';
import type { AppBudgetView } from '../gateway/proxy/app-limits';
import type { AppProfile } from '../deployments/apps';
import type { AppStatus } from '../deployments/app-gpu-health';
import { activeWindow } from '../deployments/autoscale';

type Level = 'ok' | 'warn' | 'bad';

export interface AdminAlert { event: string; at: string; summary: string }

export interface AdminApp { id: string; profile: AppProfile | null; status: AppStatus | null }

interface MachineCosts {
  global?: { dayUsd: number; committedUsd: number; capDayUsd: number };
  machines: Array<{ id: string; owner: string; holder: string | null; provider: string | null; status: string; usdPerHour: number | null; costUsd: number }>;
}

export interface AdminSnapshot {
  reserves: { intervalMinutes: number; links: FallbackProbeResult[] };
  balances: BalanceReading[];
  providerCredit: CreditIssue[];
  gpus: DeploymentView[] | null;
  gpuSpend: { spentEur: Record<string, number> } | null;
  alerts: AdminAlert[];
  machines: MachineCosts | null;
  keys: KeyView[];
  apps: AdminApp[];
  appBudgets: AppBudgetView[];
}

interface Section { id: string; title: string; level: Level; checkedAt: string | null; body: string }

const ALERT_FRESH_MS = 60 * 60_000;
const NEAR_LIMIT = 0.8;
const ZONE = 'Europe/Paris';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const worst = (levels: Level[]): Level => (levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok');
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
const count = (v: number) => new Intl.NumberFormat('pt-BR', { notation: v >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(v);
const latest = (dates: Array<string | null | undefined>) => dates.filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;

const ago = (iso: string | null, now: number) => {
  if (!iso) return 'nunca';
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  return min < 1 ? 'agora' : min < 120 ? `há ${min} min` : `há ${Math.round(min / 60)} h`;
};

function clock(iso: string | null, now: number): string {
  if (!iso) return 'nunca';
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(Date.parse(iso));
  return `${time} (${ago(iso, now)})`;
}

const duration = (seconds: number) => (seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1).replace('.', ',')} h`);

const LEVEL_TEXT: Record<Level, string> = { ok: 'Normal', warn: 'Atenção', bad: 'Problema' };
const GLYPH: Record<Level, string> = {
  ok: '<circle class="s" cx="10" cy="10" r="9"/><path class="g" d="m6 10.3 2.7 2.7L14 7.5"/>',
  warn: '<path class="s" d="M10 1.6 19.2 18H.8z"/><path class="g" d="M10 7.5v4.6m0 2.7v.1"/>',
  bad: '<path class="s" d="M6.3 1h7.4L19 6.3v7.4L13.7 19H6.3L1 13.7V6.3z"/><path class="g" d="m7 7 6 6m0-6-6 6"/>',
};
const mark = (level: Level) => `<span class="mark ${level}"><svg viewBox="0 0 20 20" aria-hidden="true">${GLYPH[level]}</svg><span class="sr">${LEVEL_TEXT[level]}:</span></span>`;
const fig = (value: string, sub = '') => `<div class="fig"><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
const row = (level: Level, title: string, detail: string, figure = '', extra = '') =>
  `<li>${mark(level)}<div class="main"><b>${esc(title)}</b>${detail ? `<small>${detail}</small>` : ''}</div>${figure}${extra ? `<div class="act">${extra}</div>` : ''}</li>`;
const list = (items: string[], empty: string) => (items.length ? `<ul>${items.join('')}</ul>` : `<p class="muted">${esc(empty)}</p>`);
const form = (action: string, csrf: string, label: string, confirmText: string, fields: Record<string, string> = {}) =>
  `<form method="post" action="${action}"${confirmText ? ` data-confirm="${esc(confirmText)}"` : ''}><input type="hidden" name="csrf" value="${csrf}">${
    Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')
  }<button>${esc(label)}</button></form>`;

const STAGE: Record<string, string> = { stt: 'Fala → texto', chat: 'Conversa', llm: 'Conversa', tts: 'Texto → fala' };

function reserves(s: AdminSnapshot, now: number, csrf: string): Section {
  const links = s.reserves.links;
  const items = links.map(r => row(r.ok ? 'ok' : 'bad', `${STAGE[r.stage] ?? r.stage}`,
    `${esc(r.target)}${r.voice ? ` · voz ${esc(r.voice)}` : ''}${r.ok ? '' : ` · <b class="bad-text">falhou: ${esc(r.code ?? '')} ${esc(r.error ?? '')}</b>`} · ${esc(clock(r.checkedAt, now))}`,
    fig(r.ok ? `${count(r.latencyMs)} ms` : 'falhou', r.ok ? 'resposta' : `${count(r.latencyMs)} ms`)));
  const level: Level = !links.length ? 'warn' : links.some(r => !r.ok) ? 'bad' : 'ok';
  const empty = 'Nenhuma reserva testada ainda (o teste roda 30 s depois do boot e a cada '
    + `${s.reserves.intervalMinutes} min).`;
  return {
    id: 'reservas', title: 'Reservas', level, checkedAt: latest(links.map(r => r.checkedAt)),
    body: list(items, empty) + form('/admin/probe', csrf, 'Testar as reservas agora', 'Testar todas as reservas agora? Cada uma recebe um pedido mínimo real.'),
  };
}

function balances(s: AdminSnapshot, now: number): Section {
  const levelOf = (r: BalanceReading): Level => (r.level === 'ok' ? 'ok' : r.level === 'warn' ? 'warn' : 'bad');
  const items = s.balances.map((r) => {
    const unit = r.currency === 'EUR' ? '€' : 'US$';
    const figure = r.balanceUsd !== null
      ? fig(money(r.balanceUsd, unit), r.hoursLeft !== null ? `~${Math.round(r.hoursLeft)} h no ritmo atual` : 'saldo')
      : r.monthEur !== null ? fig(money(r.monthEur), `de ${money(r.monthCapEur)} no mês`) : '';
    return row(levelOf(r), r.provider, [
      ...r.reasons.map(esc), r.error ? `erro: ${esc(r.error)}` : '', `lido ${esc(clock(r.checkedAt, now))}`,
    ].filter(Boolean).join(' · '), figure);
  });
  const credit = s.providerCredit.map(c => row('bad', `${c.provider}: sem crédito`, esc(c.message), fig(money(c.balanceUsd, 'US$'), `piso ${money(c.floorUsd, 'US$')}`)));
  return {
    id: 'saldos', title: 'Saldos', checkedAt: latest(s.balances.map(r => r.checkedAt)),
    level: worst([...s.balances.map(levelOf), ...(credit.length ? ['bad' as Level] : [])]),
    body: list([...credit, ...items], 'Nenhum saldo lido ainda.'),
  };
}

function outsideWindow(d: DeploymentView, now: number): boolean {
  return Boolean(d.spec.warmSchedule?.length) && d.replicas.some(r => r.phase !== 'halted') && !activeWindow(d.spec.warmSchedule, now);
}

const GPU_STATUS: Record<string, string> = { ready: 'pronta', 'scaled-to-zero': 'desligada', warming: 'ligando', degraded: 'com falha', paused: 'pausada' };
const PHASE: Record<string, string> = { ready: 'pronta', booting: 'ligando', unhealthy: 'sem resposta', halted: 'parada' };

function gpus(s: AdminSnapshot, now: number, csrf: string): Section {
  if (!s.gpus) return { id: 'gpus', title: 'GPUs', level: 'ok', checkedAt: null, body: '<p class="muted">As GPUs gerenciadas estão desligadas neste gateway.</p>' };
  const levels: Level[] = [];
  const items = s.gpus.map((d) => {
    const up = d.replicas.filter(r => r.phase !== 'halted');
    const outside = outsideWindow(d, now);
    const level: Level = outside || d.status === 'degraded' || d.lastError ? 'warn' : 'ok';
    levels.push(level);
    const perHour = up.reduce((sum, r) => sum + (r.pricePerHour ?? 0), 0);
    const detail = [
      `<span class="tag">${esc(GPU_STATUS[d.status] ?? d.status)}</span>`,
      up.length ? esc(`${up.length} ${up.length > 1 ? 'máquinas' : 'máquina'}: ${up.map(r => PHASE[r.phase] ?? r.phase).join(', ')}`) : '',
      outside ? '<b class="warn-text">fora da janela de aula</b>' : '',
      d.warm ? `aquecida até ${esc(clock(d.warm.until, now))}` : '',
      d.lastError ? `último erro: ${esc(d.lastError)}` : '',
    ].filter(Boolean).join(' · ');
    const figure = up.length ? fig(`${money(perHour)}/h`, `ligada há ${duration(Math.max(...up.map(r => r.ageSeconds)))}`) : fig('desligada', 'sem custo');
    const park = up.length ? form('/admin/park', csrf, 'Estacionar', `Estacionar ${d.name}? As réplicas sem uso desligam; pedidos em curso terminam.`, { name: d.name }) : '';
    return { level, html: row(level, d.name, detail, figure, park) };
  }).sort((a, b) => RANK[a.level] - RANK[b.level]).map(x => x.html);
  return { id: 'gpus', title: 'GPUs', level: worst(levels), checkedAt: null, body: list(items, 'Nenhuma GPU registrada.') };
}

function alerts(s: AdminSnapshot, now: number): Section {
  const fresh = s.alerts.filter(a => now - Date.parse(a.at) < ALERT_FRESH_MS);
  const items = s.alerts.slice(0, 15).map(a => row(now - Date.parse(a.at) < ALERT_FRESH_MS ? 'warn' : 'ok', a.event, esc(a.summary), fig(esc(ago(a.at, now)), esc(clock(a.at, now).split(' ')[0]))));
  return {
    id: 'alertas', title: 'Avisos e alertas', level: fresh.length ? 'warn' : 'ok', checkedAt: s.alerts[0]?.at ?? null,
    body: (s.alerts.length ? `<p class="muted">Em amarelo, os da última hora.</p>` : '') + list(items, 'Nenhum alerta desde o boot.'),
  };
}

function machines(s: AdminSnapshot): Section {
  if (!s.machines) return { id: 'maquinas', title: 'Máquinas avulsas', level: 'ok', checkedAt: null, body: '<p class="muted">As máquinas avulsas estão desligadas neste gateway.</p>' };
  const live = s.machines.machines.filter(m => m.status === 'creating' || m.status === 'running');
  const g = s.machines.global;
  const level = g ? ratioLevel(g.dayUsd, g.capDayUsd) : 'ok';
  const items = live.map(m => row('ok', `${m.id} · ${m.owner}${m.holder ? ` / ${m.holder}` : ''}`,
    esc(`${m.provider ?? '?'} · ${m.status === 'running' ? 'ligada' : 'ligando'} · gasto ${money(m.costUsd, 'US$')}`), fig(`${money(m.usdPerHour, 'US$')}/h`)));
  const day = g ? `<p class="total">Gasto em 24 h <b>${money(g.dayUsd, 'US$')}</b> de ${money(g.capDayUsd, 'US$')} <small>reservado ${money(g.committedUsd, 'US$')}</small></p>` : '';
  return { id: 'maquinas', title: 'Máquinas avulsas', level, checkedAt: null, body: day + list(items, 'Nenhuma máquina ligada.') };
}

function keys(s: AdminSnapshot, now: number): Section {
  const items = s.keys.filter(k => k.active).map((k) => {
    const p = k.policy;
    const policy = [
      p.neverWake ? 'nunca acorda GPU' : p.autoWake ? 'acorda GPU' : 'não acorda sozinha',
      p.autoWakeOutsideClass ? 'fora da aula também' : 'só na aula',
      p.wakeDeployments.length ? `acorda só ${p.wakeDeployments.join(', ')}` : '',
      p.countsAsUse ? '' : 'não conta como uso',
      p.gpuDailyEur === null ? 'GPU sem teto diário' : `teto GPU ${money(p.gpuDailyEur)}/dia`,
    ].filter(Boolean).join(' · ');
    return row('ok', `${k.user}${k.label ? ` (${k.label})` : ''}`,
      `<span class="tag">${esc(k.role)}</span> ${k.source === 'env' ? 'variável' : 'emitida'} · ${esc(policy)}`, fig(esc(ago(k.lastUsedAt, now)), 'último uso'));
  });
  const byId = new Map(s.keys.map(k => [k.id, k]));
  const levels: Level[] = [];
  const gpu = Object.entries(s.gpuSpend?.spentEur ?? {}).map(([id, eur]) => {
    const k = byId.get(id);
    const cap = k?.policy.gpuDailyEur ?? null;
    const level = ratioLevel(eur, cap);
    levels.push(level);
    return row(level, `GPU hoje: ${k ? `${k.user}${k.label ? ` (${k.label})` : ''}` : 'chave removida'}`, '', fig(money(eur), `de ${money(cap)}`));
  });
  return { id: 'chaves', title: 'Chaves', level: worst(levels), checkedAt: null, body: list([...gpu, ...items], 'Nenhuma chave ativa.') };
}

const MODE: Record<string, { level: Level; text: string }> = {
  gpu: { level: 'ok', text: 'na GPU' }, degraded: { level: 'warn', text: 'na reserva de nuvem' }, down: { level: 'bad', text: 'fora do ar' },
};

function apps(s: AdminSnapshot, filter: string | null): Section {
  const ids = [...new Set([...s.apps.map(a => a.id), ...s.appBudgets.map(b => b.app)])].filter(id => !filter || id === filter).sort();
  const levels: Level[] = [];
  const items = ids.map((id) => {
    const app = s.apps.find(a => a.id === id);
    const budget = s.appBudgets.find(b => b.app === id);
    const mode = app?.status ? MODE[app.status.mode] : null;
    const level = worst([
      mode?.level ?? 'ok',
      budget ? ratioLevel(budget.requests.used, budget.requests.limit) : 'ok',
      budget ? ratioLevel(budget.tokens.used, budget.tokens.limit) : 'ok',
    ]);
    levels.push(level);
    const profile = app?.profile
      ? `${app.profile.requiresGpu ? 'precisa de GPU' : 'GPU opcional'}${app.profile.gpuDeployments.length ? ` (${app.profile.gpuDeployments.join(', ')})` : ''}`
      : 'sem perfil';
    const use = budget
      ? `tokens ${count(budget.tokens.used)} de ${budget.tokens.limit ? count(budget.tokens.limit) : '∞'}${budget.requests.exhaustedAt || budget.tokens.exhaustedAt ? ' · esgota hoje' : ''}`
      : '';
    const gpus = app?.status?.deployments.map(d => `${d.name} ${d.state} ${d.replicas.ready}/${d.replicas.total}`).join(', ');
    const served = mode ? (mode.level === 'ok' ? esc(`servindo ${mode.text}`) : `<b class="${mode.level}-text">servindo ${esc(mode.text)}</b>`) : '';
    const figure = budget
      ? fig(`${count(budget.requests.used)} pedidos`, `de ${budget.requests.limit ? count(budget.requests.limit) : '∞'} hoje`)
      : fig('0 pedidos', 'hoje');
    return { level, html: `<li>${mark(level)}<div class="main"><b><a href="/admin?app=${encodeURIComponent(id)}#apps">${esc(id)}</a></b><small>${
      [esc(profile), served, esc(gpus ?? ''), esc(use)].filter(Boolean).join(' · ')}</small></div>${figure}</li>` };
  }).sort((a, b) => RANK[a.level] - RANK[b.level]).map(x => x.html);
  const head = filter ? `<p class="muted">Só o app <b>${esc(filter)}</b> · <a href="/admin#apps">ver todos</a></p>` : '';
  return { id: 'apps', title: 'Apps', level: worst(levels), checkedAt: null, body: head + list(items, filter ? 'Nenhum app com esse nome.' : 'Nenhum app registrado.') };
}

const RANK: Record<Level, number> = { bad: 0, warn: 1, ok: 2 };

function sections(s: AdminSnapshot, now: number, csrf: string, app: string | null): Section[] {
  return [reserves(s, now, csrf), balances(s, now), gpus(s, now, csrf), alerts(s, now), machines(s), keys(s, now), apps(s, app)]
    .sort((a, b) => RANK[a.level] - RANK[b.level]);
}

const HEADLINE: Record<Level, string> = { ok: 'Tudo funcionando', warn: 'Funcionando, com avisos', bad: 'Algo está fora do ar' };

const CSS = `
:root{color-scheme:light dark;--bg:#f4f4f6;--surface:#fff;--raise:#ececf0;--line:#dcdce2;--text:#16161a;--muted:#55555f;--focus:#2457d6;
--ok:#137a45;--warn:#8a5300;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--surface:#222227;--raise:#2d2d33;--line:#36363e;--text:#ededf1;--muted:#a6a6b1;--focus:#8ab0ff;
--ok:#5fd39a;--warn:#ebb45c;--bad:#ff8a80}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
::selection{background:color-mix(in srgb,var(--focus) 30%,transparent)}
main{max-width:820px;margin:0 auto;padding:12px 16px 40px}
h1{font-size:26px;line-height:1.15;margin:0;letter-spacing:-.01em;text-wrap:balance}
h2{font-size:18px;margin:0;display:flex;gap:10px;align-items:center}
a{color:inherit;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.ok{--lvl:var(--ok)}.warn{--lvl:var(--warn)}.bad{--lvl:var(--bad)}
.ok-text{color:var(--ok)}.warn-text{color:var(--warn)}.bad-text{color:var(--bad)}
.mark{display:inline-flex;flex:none;color:var(--lvl)}.mark svg{width:20px;height:20px;overflow:visible}
.mark .s{fill:currentColor}.mark .g{fill:none;stroke:var(--surface);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:44px;margin-bottom:8px}
.brand{font-weight:600;color:var(--muted)}
.hero{display:flex;gap:14px;align-items:flex-start;padding:20px;border-radius:16px;margin-bottom:16px;
background:color-mix(in srgb,var(--lvl) 14%,var(--surface));border:1px solid color-mix(in srgb,var(--lvl) 45%,var(--line))}
.hero .mark svg{width:36px;height:36px}.hero .g{stroke:color-mix(in srgb,var(--lvl) 14%,var(--surface));stroke-width:2.4}
.hero p{margin:8px 0 0;color:var(--text)}.hero small{display:block;margin-top:8px;color:var(--muted);font-size:13px}
.hero a{font-weight:600}
nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
nav a{display:flex;gap:8px;align-items:center;min-height:44px;padding:0 14px;border-radius:999px;background:var(--surface);border:1px solid var(--line);
text-decoration:none;font-size:15px}
nav a .mark svg{width:16px;height:16px}
section{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:16px;scroll-margin-top:12px}
section:has(>.head.bad){border-color:color-mix(in srgb,var(--bad) 55%,var(--line))}section:has(>.head.warn){border-color:color-mix(in srgb,var(--warn) 50%,var(--line))}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.badge{font-size:13px;font-weight:600;color:var(--lvl);background:color-mix(in srgb,var(--lvl) 14%,var(--surface));padding:3px 10px;border-radius:999px}
.checked{color:var(--muted);font-size:13px;margin:4px 0 0}
ul{list-style:none;margin:8px 0 0;padding:0}
li{display:grid;grid-template-columns:20px minmax(0,1fr) auto;column-gap:12px;align-items:start;padding:12px 0;border-top:1px solid var(--line)}
li:first-child{border-top:0}li>.mark{margin-top:2px}
.main{min-width:0;overflow-wrap:anywhere}.main>b{font-size:16px}
small{display:block;color:var(--muted);font-size:14px;margin-top:2px}
.fig{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.fig b{font-size:17px}.fig small{font-size:13px}
.total{margin:8px 0 0;font-variant-numeric:tabular-nums}.total b{font-size:20px}.total small{display:inline;margin-left:6px}
.muted{color:var(--muted);margin:6px 0 0}
.tag{display:inline-block;font-size:13px;color:var(--text);background:var(--raise);border-radius:6px;padding:0 6px}
button{min-height:44px;margin-top:12px;padding:0 16px;border-radius:12px;border:1px solid var(--line);background:var(--raise);color:var(--text);
font:inherit;font-weight:600;cursor:pointer}
button:hover{border-color:var(--muted)}button:active{transform:translateY(1px)}
.bar button{margin:0;background:transparent}
.act{grid-column:2}.act button{margin-top:10px}
input[type=password]{width:100%;min-height:48px;margin-top:6px;padding:0 14px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
label{font-weight:600}.login button{width:100%;background:var(--text);color:var(--surface);border-color:var(--text)}
.msg{padding:12px 16px;border-radius:12px;background:var(--surface);border:1px solid var(--line);margin:0 0 16px}
@media (max-width:520px){li{grid-template-columns:20px minmax(0,1fr)}.fig{grid-column:2;text-align:left;margin-top:6px;white-space:normal}
.fig b,.fig small{display:inline}.fig small{margin-left:6px}h1{font-size:24px}}`;

const CONFIRM_JS = `var l=document.getElementById('login');if(l)l.addEventListener('submit',function(){l.next.value+=location.hash});document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!confirm(f.dataset.confirm))e.preventDefault()})})`;

function page(nonce: string, title: string, body: string, refresh = false): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    refresh ? '<meta http-equiv="refresh" content="60">' : ''}<meta name="robots" content="noindex"><title>${esc(title)}</title><style nonce="${nonce}">${CSS}</style></head><body><main>${body}</main>`
    + `<script nonce="${nonce}">${CONFIRM_JS}</script></body></html>`;
}

export function renderLogin(nonce: string, error: string | null, next = '/admin'): string {
  return page(nonce, 'ai-gateway · entrar', `<div class="bar"><span class="brand">ai-gateway</span></div><h1>Painel do gateway</h1>`
    + `<p class="muted">Cole a chave admin uma vez; a sessão dura 12 h neste aparelho.</p>${
    error ? `<p class="msg" role="alert">${esc(error)}</p>` : ''}<section class="login"><form method="post" action="/admin/login" id="login"><input type="hidden" name="next" value="${esc(next)}"><label for="key">Chave admin</label>`
    + '<input id="key" name="key" type="password" autocomplete="current-password" required autofocus><button>Entrar</button></form></section>');
}

function summary(all: Section[]): string {
  const link = (x: Section) => `<a href="#${x.id}">${esc(x.title)}</a>`;
  const bad = all.filter(x => x.level === 'bad');
  const warn = all.filter(x => x.level === 'warn');
  if (!bad.length && !warn.length) return `<p>As ${all.length} áreas estão normais.</p>`;
  return [bad.length ? `<p>Com problema: ${bad.map(link).join(', ')}.</p>` : '', warn.length ? `<p>Pedem atenção: ${warn.map(link).join(', ')}.</p>` : ''].join('');
}

export function renderStatus(nonce: string, s: AdminSnapshot, opts: { now: number; csrf: string; actor: string; message: string | null; app: string | null }): string {
  const all = sections(s, opts.now, opts.csrf, opts.app);
  const overall = worst(all.map(x => x.level));
  const nav = all.map(x => `<a href="#${x.id}" class="${x.level}">${mark(x.level)}${esc(x.title)}</a>`).join('');
  const body = all.map(x => `<section id="${x.id}"><div class="head ${x.level}"><h2>${mark(x.level)}${esc(x.title)}</h2><span class="badge">${LEVEL_TEXT[x.level]}</span></div>${
    x.checkedAt ? `<p class="checked">Verificado às ${esc(clock(x.checkedAt, opts.now))}</p>` : ''}${x.body}</section>`).join('');
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(opts.now);
  return page(nonce, `ai-gateway · ${HEADLINE[overall]}`,
    `<div class="bar"><span class="brand">ai-gateway</span>${form('/admin/logout', opts.csrf, 'Sair', '')}</div>`
    + `${opts.message ? `<p class="msg" role="status">${esc(opts.message)}</p>` : ''}<header class="hero ${overall}">${mark(overall)}<div><h1>${HEADLINE[overall]}</h1>${
      summary(all)}<small>${esc(opts.actor)} · atualizada às ${time} (Paris) · recarrega sozinha a cada 1 min</small></div></header><nav aria-label="Seções">${nav}</nav>${body}`, true);
}
