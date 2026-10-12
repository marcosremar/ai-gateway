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
const money = (v: number | null | undefined, unit = '€') => (v === null || v === undefined ? '—' : `${v.toFixed(2)} ${unit}`);
const latest = (dates: Array<string | null | undefined>) => dates.filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;

function clock(iso: string | null, now: number): string {
  if (!iso) return 'nunca';
  const t = Date.parse(iso);
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(t);
  const ago = Math.round((now - t) / 60_000);
  return `${time} (${ago < 1 ? 'agora' : ago < 120 ? `há ${ago} min` : `há ${Math.round(ago / 60)} h`})`;
}

const duration = (seconds: number) => (seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`);
const dot = (level: Level) => `<span class="dot ${level}"></span>`;
const row = (level: Level, title: string, detail: string) => `<li>${dot(level)}<div><b>${esc(title)}</b><small>${detail}</small></div></li>`;
const list = (items: string[], empty: string) => (items.length ? `<ul>${items.join('')}</ul>` : `<p class="muted">${esc(empty)}</p>`);
const form = (action: string, csrf: string, label: string, confirmText: string, fields: Record<string, string> = {}) =>
  `<form method="post" action="${action}"${confirmText ? ` data-confirm="${esc(confirmText)}"` : ''}><input type="hidden" name="csrf" value="${csrf}">${
    Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')
  }<button>${esc(label)}</button></form>`;

function reserves(s: AdminSnapshot, now: number, csrf: string): Section {
  const links = s.reserves.links;
  const items = links.map(r => row(r.ok ? 'ok' : 'bad', `${r.stage} · ${r.target}${r.voice ? ` (${r.voice})` : ''}`,
    `${r.ok ? 'ok' : `falhou: ${esc(r.code ?? '')} ${esc(r.error ?? '')}`} · ${r.latencyMs} ms · ${esc(clock(r.checkedAt, now))}`));
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
  const items = s.balances.map(r => row(levelOf(r), r.provider, [
    r.balanceUsd !== null ? money(r.balanceUsd, r.currency === 'EUR' ? '€' : 'US$') : '',
    r.hoursLeft !== null ? `~${Math.round(r.hoursLeft)} h no ritmo atual` : '',
    r.monthEur !== null ? `mês ${money(r.monthEur)} de ${money(r.monthCapEur)}` : '',
    ...r.reasons.map(esc), r.error ? `erro: ${esc(r.error)}` : '', esc(clock(r.checkedAt, now)),
  ].filter(Boolean).join(' · ')));
  const credit = s.providerCredit.map(c => row('bad', `${c.provider}: crédito`, `${esc(c.message)} · saldo ${money(c.balanceUsd, 'US$')}, piso ${money(c.floorUsd, 'US$')}`));
  return {
    id: 'saldos', title: 'Saldos', checkedAt: latest(s.balances.map(r => r.checkedAt)),
    level: worst([...s.balances.map(levelOf), ...(credit.length ? ['bad' as Level] : [])]),
    body: list([...items, ...credit], 'Nenhum saldo lido ainda.'),
  };
}

function outsideWindow(d: DeploymentView, now: number): boolean {
  return Boolean(d.spec.warmSchedule?.length) && d.replicas.some(r => r.phase !== 'halted') && !activeWindow(d.spec.warmSchedule, now);
}

function gpus(s: AdminSnapshot, now: number, csrf: string): Section {
  if (!s.gpus) return { id: 'gpus', title: 'GPUs', level: 'ok', checkedAt: null, body: '<p class="muted">Deployments desligados neste gateway.</p>' };
  const levels: Level[] = [];
  const items = s.gpus.map((d) => {
    const up = d.replicas.filter(r => r.phase !== 'halted');
    const outside = outsideWindow(d, now);
    const level: Level = outside || d.status === 'degraded' || d.lastError ? 'warn' : 'ok';
    levels.push(level);
    const perHour = up.reduce((sum, r) => sum + (r.pricePerHour ?? 0), 0);
    const detail = up.length
      ? `${up.length} ligada(s) · ${up.map(r => r.phase).join(', ')} · há ${duration(Math.max(...up.map(r => r.ageSeconds)))} · ${money(perHour)}/h`
      : 'desligada';
    return `<li>${dot(level)}<div><b>${esc(d.name)}</b> <span class="tag">${esc(d.status)}</span><small>${esc(detail)}${
      outside ? ' · <b class="warn-text">fora da janela de aula</b>' : ''}${d.warm ? ` · aquecida até ${esc(clock(d.warm.until, now))}` : ''}${
      d.lastError ? ` · último erro: ${esc(d.lastError)}` : ''}</small>${
      up.length ? form('/admin/park', csrf, 'Estacionar', `Estacionar ${d.name}? As réplicas sem uso desligam; pedidos em curso terminam.`, { name: d.name }) : ''}</div></li>`;
  });
  return { id: 'gpus', title: 'GPUs', level: worst(levels), checkedAt: null, body: list(items, 'Nenhum deployment registrado.') };
}

function alerts(s: AdminSnapshot, now: number): Section {
  const fresh = s.alerts.filter(a => now - Date.parse(a.at) < ALERT_FRESH_MS);
  const items = s.alerts.slice(0, 15).map(a => row(now - Date.parse(a.at) < ALERT_FRESH_MS ? 'warn' : 'ok', a.event, `${esc(clock(a.at, now))} · ${esc(a.summary)}`));
  return { id: 'alertas', title: 'Avisos e alertas', level: fresh.length ? 'warn' : 'ok', checkedAt: s.alerts[0]?.at ?? null, body: list(items, 'Nenhum alerta desde o boot.') };
}

function machines(s: AdminSnapshot): Section {
  if (!s.machines) return { id: 'maquinas', title: 'Máquinas avulsas', level: 'ok', checkedAt: null, body: '<p class="muted">Máquinas desligadas neste gateway.</p>' };
  const live = s.machines.machines.filter(m => m.status === 'creating' || m.status === 'running');
  const g = s.machines.global;
  const level = g ? ratioLevel(g.dayUsd, g.capDayUsd) : 'ok';
  const items = live.map(m => row('ok', `${m.id} · ${m.owner}${m.holder ? ` / ${m.holder}` : ''}`,
    esc(`${m.provider ?? '?'} · ${m.status} · ${money(m.usdPerHour, 'US$')}/h · gasto ${money(m.costUsd, 'US$')}`)));
  const day = g ? `<p>Gasto em 24 h: <b>${money(g.dayUsd, 'US$')}</b> de ${money(g.capDayUsd, 'US$')} (comprometido ${money(g.committedUsd, 'US$')})</p>` : '';
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
      `<span class="tag">${esc(k.role)}</span> ${k.source === 'env' ? 'variável' : 'emitida'} · ${esc(policy)} · último uso ${esc(clock(k.lastUsedAt, now))}`);
  });
  const byId = new Map(s.keys.map(k => [k.id, k]));
  const levels: Level[] = [];
  const gpu = Object.entries(s.gpuSpend?.spentEur ?? {}).map(([id, eur]) => {
    const k = byId.get(id);
    const cap = k?.policy.gpuDailyEur ?? null;
    const level = ratioLevel(eur, cap);
    levels.push(level);
    return row(level, `GPU hoje: ${k ? `${k.user}${k.label ? ` (${k.label})` : ''}` : 'chave removida'}`, esc(`${money(eur)} de ${money(cap)}`));
  });
  return { id: 'chaves', title: 'Chaves', level: worst(levels), checkedAt: null, body: list([...items, ...gpu], 'Nenhuma chave ativa.') };
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
      ? `hoje: pedidos ${budget.requests.used}/${budget.requests.limit || '∞'} · tokens ${budget.tokens.used}/${budget.tokens.limit || '∞'}${
        budget.requests.exhaustedAt || budget.tokens.exhaustedAt ? ' · esgota hoje' : ''}`
      : 'nenhum pedido hoje';
    const gpus = app?.status?.deployments.map(d => `${d.name} ${d.state} ${d.replicas.ready}/${d.replicas.total}`).join(', ');
    return `<li>${dot(level)}<div><b><a href="/admin?app=${encodeURIComponent(id)}#apps">${esc(id)}</a></b><small>${esc(
      [profile, mode ? `servindo ${mode.text}` : '', gpus ?? '', use].filter(Boolean).join(' · '))}</small></div></li>`;
  });
  const head = filter ? `<p class="muted">Só o app <b>${esc(filter)}</b> · <a href="/admin#apps">ver todos</a></p>` : '';
  return { id: 'apps', title: 'Apps', level: worst(levels), checkedAt: null, body: head + list(items, filter ? 'Nenhum app com esse nome.' : 'Nenhum app registrado.') };
}

function sections(s: AdminSnapshot, now: number, csrf: string, app: string | null): Section[] {
  return [reserves(s, now, csrf), balances(s, now), gpus(s, now, csrf), alerts(s, now), machines(s), keys(s, now), apps(s, app)];
}

const HEADLINE: Record<Level, string> = { ok: 'Tudo funcionando', warn: 'Funcionando, com avisos', bad: 'Algo está fora do ar' };

const CSS = `
:root{color-scheme:dark;--bg:#1b1b1f;--surface:#24242a;--line:#34343c;--text:#ececf1;--muted:#a3a3ae;--ok:#5fd39a;--warn:#e0a84a;--bad:#ff7d7d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:22px;margin:0}h2{font-size:16px;margin:0;display:flex;gap:8px;align-items:center}
.hero{display:flex;gap:12px;align-items:center;padding:16px;border-radius:12px;background:var(--surface);margin-bottom:12px}
.hero .dot{width:22px;height:22px;flex:none}
section{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:12px}
.head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px}
ul{list-style:none;margin:0;padding:0}li{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}
li>div{min-width:0;overflow-wrap:anywhere}small{display:block;color:var(--muted)}
.dot{display:inline-block;width:12px;height:12px;border-radius:50%;margin-top:4px;flex:none}.ok{background:var(--ok)}.warn{background:var(--warn)}.bad{background:var(--bad)}
.warn-text{color:var(--warn)}.muted{color:var(--muted);margin:4px 0}.tag{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:0 5px}
button{min-height:44px;margin-top:8px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:#2c2c33;color:var(--text);font:inherit}
input[type=password]{width:100%;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:#2c2c33;color:var(--text);font:inherit}
.bar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px}.bar form button{margin:0}
.msg{padding:10px 14px;border-radius:10px;background:#2c2c33;margin-bottom:12px}nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
a{color:var(--text)}nav a{color:var(--text);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:13px;display:flex;gap:6px;align-items:center}
nav .dot{margin:0;width:9px;height:9px}`;

const CONFIRM_JS = `var l=document.getElementById('login');if(l)l.addEventListener('submit',function(){l.next.value+=location.hash});document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!confirm(f.dataset.confirm))e.preventDefault()})})`;

function page(nonce: string, title: string, body: string, refresh = false): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    refresh ? '<meta http-equiv="refresh" content="60">' : ''}<meta name="robots" content="noindex"><title>${esc(title)}</title><style nonce="${nonce}">${CSS}</style></head><body><main>${body}</main>`
    + `<script nonce="${nonce}">${CONFIRM_JS}</script></body></html>`;
}

export function renderLogin(nonce: string, error: string | null, next = '/admin'): string {
  return page(nonce, 'ai-gateway · entrar', `<h1>ai-gateway · admin</h1><p class="muted">Cole a chave admin uma vez; a sessão dura 12 h neste aparelho.</p>${
    error ? `<p class="msg">${esc(error)}</p>` : ''}<section><form method="post" action="/admin/login" id="login"><input type="hidden" name="next" value="${esc(next)}"><label for="key">Chave admin</label>`
    + '<input id="key" name="key" type="password" autocomplete="current-password" required autofocus><button>Entrar</button></form></section>');
}

export function renderStatus(nonce: string, s: AdminSnapshot, opts: { now: number; csrf: string; actor: string; message: string | null; app: string | null }): string {
  const all = sections(s, opts.now, opts.csrf, opts.app);
  const overall = worst(all.map(x => x.level));
  const nav = all.map(x => `<a href="#${x.id}">${dot(x.level)}${esc(x.title)}</a>`).join('');
  const body = all.map(x => `<section id="${x.id}"><div class="head"><h2>${dot(x.level)}${esc(x.title)}</h2>${
    x.checkedAt ? `<small>checado ${esc(clock(x.checkedAt, opts.now))}</small>` : ''}</div>${x.body}</section>`).join('');
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(opts.now);
  return page(nonce, `ai-gateway · ${HEADLINE[overall]}`,
    `<div class="bar"><small>${esc(opts.actor)} · página de ${time} (Paris), recarrega a cada 1 min</small>${
      form('/admin/logout', opts.csrf, 'Sair', '')}</div>`
    + `${opts.message ? `<p class="msg">${esc(opts.message)}</p>` : ''}<div class="hero">${dot(overall)}<h1>${HEADLINE[overall]}</h1></div><nav>${nav}</nav>${body}`, true);
}
