import type { FallbackProbeResult } from '../telemetry/fallback-probe';
import type { BalanceReading } from '../telemetry/balance-watch';
import type { CreditIssue, DeploymentView } from '../deployments/types';
import type { KeyView } from '../config/access-keys';
import type { KeyAuditEntry } from '../config/key-audit';
import type { AppBudgetView } from '../gateway/proxy/app-limits';
import type { AppProfile } from '../deployments/apps';
import type { AppStatus } from '../deployments/app-gpu-health';
import { activeWindow } from '../deployments/autoscale';
import { idleGpu } from '../deployments/idle';
import type { AdminTraffic, TrafficLine } from './traffic';
import { CSS } from './styles';
import type { SpendLedgerView } from '../deployments/spend-ledger';
import { spend, spendWindow } from './spend';
import { parisMidnightAfter } from '../deployments/spend-ledger';
import { EUR_TO_USD } from '../deployments/vast-backend';
import { guarantee } from './guarantee';
import { bootHeadline, bootLevel, bootOf, bootState, detailHref, gpuDetailBody, nextStep } from './boot';
import type { BootLogLine } from '../deployments/boot-track';
import type { ChainReport } from '../config/stage-chains';
import { recommendations, recoSection, type Recommendation } from './recommendations';
import {
  ACTIVITY_SHOWN, ALERT_FRESH_MS, LEVEL_TEXT, ZONE, ago, appTitle, byLevel, count, duration, esc, form, hhmm, hour, latest, mark, meter, ms, money, outsideWindow, pct, pill,
  pinBadge, plural, providerLabel, providerOf, ratioLevel, stageName, table, upOf, when, worst, type Ctx, type Level, type Section,
} from './ui';

export interface AdminAlert { event: string; at: string; summary: string }

export interface AdminApp { id: string; profile: AppProfile | null; status: AppStatus | null; aliases?: string[]; stages?: Record<string, string[]> }

export interface AppView { id: string; canPark: boolean }

interface MachineCosts {
  global?: { dayUsd: number; committedUsd: number; capDayUsd: number };
  machines: Array<{
    id: string; owner: string; holder: string | null; provider: string | null; status: string; usdPerHour: number | null; costUsd: number;
    createdAt?: number; lastError?: string | null; jobId?: string | null;
  }>;
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
  spend?: SpendLedgerView | null;
  gpuLogs?: Record<string, BootLogLine[]>;
  dismissed?: Record<string, number>;
  about?: AdminAbout | null;
  chains?: Record<string, Record<string, ChainReport>> | null;
}

export interface AdminAbout { commit: string | null; uptimeSeconds: number; region: string | null; telemetryAt: string | null }



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

function gpuCost(d: DeploymentView, eurPerHour: number, now: number): string {
  const today = (eurPerHour * Math.min(...upOf(d).map(r => r.ageSeconds), (now - (parisMidnightAfter(now) - 86_400_000)) / 1000)) / 3600;
  return providerOf(d) === 'vast'
    ? `${money(eurPerHour * EUR_TO_USD, 'US$')}/h<small>${money(eurPerHour)}/h · hoje ≈ ${money(today * EUR_TO_USD, 'US$')}</small>`
    : `${money(eurPerHour)}/h<small>hoje ≈ ${money(today)}</small>`;
}

const pinForm = (d: DeploymentView, csrf: string) => (d.pinned
  ? form('/admin/pin', csrf, 'Soltar', `Soltar ${d.name}? Ela volta a desligar após ${d.spec.idleMinutes} min sem uso.`, { name: d.name, on: '0' }, 'quiet')
  : form('/admin/pin', csrf, 'Fixar', `Fixar ${d.name}? Uma réplica fica ligada e só estaciona após 1 h sem pedido.`, { name: d.name, on: '1' }, 'quiet'));

function gpus({ s, now, csrf, view }: Ctx): Section {
  const base = { id: 'gpus', title: 'GPUs', actions: '' };
  if (!s.gpus) return { ...base, level: 'ok', note: '', count: null, meta: '', body: '<p class="empty">As GPUs gerenciadas estão desligadas neste gateway.</p>' };
  const keys = new Map(s.keys.map(k => [k.id, k]));
  const rows = s.gpus.map((d) => {
    const up = upOf(d);
    const outside = outsideWindow(d, now);
    const idle = idleGpu(d, now);
    const classWindow = up.length ? activeWindow(d.spec.warmSchedule, now) : null;
    const level: Level = worst([d.status === 'degraded' || d.lastError || outside || idle ? 'warn' : 'ok', bootLevel(d) ?? 'ok']);
    const perHour = up.reduce((sum, r) => sum + (r.pricePerHour ?? 0), 0);
    const ready = up.filter(r => r.phase === 'ready').length;
    const first = up[0];
    const by = [
      ...(s.gpuSpend?.running ?? []).filter(r => r.deployment === d.name).map(r => `${esc(keyName(keys.get(r.key)))} até ${hhmm(r.until)}`),
      d.warm ? `aquecida até ${hhmm(d.warm.until)}` : '',
      classWindow ? `aquecida para a aula até ${hhmm(classWindow.endsAt)}` : '',
    ].filter(Boolean);
    const state = (bootOf(d) ? bootState(d) : pill(level, GPU_STATUS[d.status] ?? d.status))
      + (d.pinned ? pinBadge(d) : typeof d.spec.idleMinutes === 'number' ? `<small>desliga após ${d.spec.idleMinutes} min sem uso</small>` : '')
      + (idle ? `<small class="err">sem uso há ${Math.round(idle.minutes)} min · ${money(idle.wastedEur)} gastos · ${money(idle.eurPerHour)}/h</small>` : '')
      + (outside ? '<small>fora da janela de aula</small>' : '') + (d.lastError ? `<small class="err">${esc(d.lastError)}</small><small>${esc(nextStep(d))}</small>` : '');
    return { level, cells: [
      `<a href="${detailHref(d)}"><b class="mono">${esc(d.name)}</b></a><small>${d.app ? `app ${esc(d.app)} · ` : ''}${esc(providerLabel(d))}</small>`
        + `<small><a href="${detailHref(d)}">detalhes e log</a></small>`,
      state,
      up.length ? `${ready}/${up.length}` : '0',
      first ? `${esc(first.machineType)}<small>${esc(first.zone)}</small>` : esc(d.spec.machineType),
      up.length ? gpuCost(d, perHour, now) : '—',
      up.length ? `${duration(Math.max(...up.map(r => r.ageSeconds)))}<small>desde ${hhmm(now - Math.max(...up.map(r => r.ageSeconds)) * 1000)}</small>` : '—',
      when(d.lastRequestAt, now),
      by.length ? by.join('<br>') : '—',
      [
        up.length && (!view || (view.canPark && d.app === view.id)) ? form('/admin/park', csrf, 'Estacionar', `Estacionar ${d.name}? As réplicas sem uso desligam; pedidos em curso terminam.`, { name: d.name }, 'danger') : '',
        !view && providerOf(d) === 'vast' ? pinForm(d, csrf) : '',
      ].join(''),
    ] };
  }).sort(byLevel);
  const on = s.gpus.filter(d => upOf(d).length);
  const perHour = on.flatMap(upOf).reduce((sum, r) => sum + (r.pricePerHour ?? 0), 0);
  const level = worst(rows.map(r => r.level));
  return {
    ...base, level, count: s.gpus.length,
    note: s.gpus.map((d) => {
      const boot = bootOf(d);
      if (boot) return `${d.name}: ${bootHeadline(boot)}`;
      const idle = idleGpu(d, now);
      if (idle) return `${d.name} ligada sem uso há ${Math.round(idle.minutes)} min: ${money(idle.wastedEur)} gastos, ${money(idle.eurPerHour)}/h`;
      if (outsideWindow(d, now)) return `${d.name} ligada fora da janela de aula`;
      return d.status === 'degraded' || d.lastError ? `${d.name} ${GPU_STATUS[d.status] ?? d.status}` : '';
    }).filter(Boolean).join(' · '),
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

function machineDetail(m: MachineCosts['machines'][number], now: number): string {
  const items = [
    m.createdAt ? `criada às ${hhmm(m.createdAt)} (há ${duration((now - m.createdAt) / 1000)})` : '', m.jobId ? `tarefa ${m.jobId}` : '',
    m.lastError ? `último erro: ${m.lastError}` : '', 'o log da tarefa fica em GET /v1/jobs/<id>/logs',
  ].filter(Boolean);
  return `<details><summary>detalhes</summary><small>${items.map(esc).join('<br>')}</small></details>`;
}

function machines({ s, now }: Ctx): Section {
  const base = { id: 'maquinas', title: 'Máquinas avulsas', actions: '' };
  if (!s.machines) return { ...base, level: 'ok', note: '', count: null, meta: '', body: '<p class="empty">As máquinas avulsas estão desligadas neste gateway.</p>' };
  const live = s.machines.machines.filter(m => m.status === 'creating' || m.status === 'running');
  const g = s.machines.global;
  const level = g ? ratioLevel(g.dayUsd, g.capDayUsd) : 'ok';
  const stats = g ? `<div class="stats"><div><span>Gasto em 24 h</span><b>${money(g.dayUsd, 'US$')}</b></div><div><span>Teto de 24 h</span><b>${money(g.capDayUsd, 'US$')}</b></div>`
    + `<div><span>Reservado</span><b>${money(g.committedUsd, 'US$')}</b></div><div><span>Uso do teto</span><b>${pct(g.capDayUsd ? g.dayUsd / g.capDayUsd : 0)}</b>${meter(g.dayUsd, g.capDayUsd, level)}</div></div>` : '';
  const rows = live.map(m => [
    `<b class="mono">${esc(m.id)}</b>${machineDetail(m, now)}`, `${esc(m.owner)}${m.holder ? `<small>${esc(m.holder)}</small>` : ''}`, esc(m.provider ?? '—'),
    m.status === 'running' ? pill('ok', 'ligada')
      : `${pill('warn', 'Iniciando')}${m.createdAt ? `<small>há ${esc(duration((now - m.createdAt) / 1000))}</small>` : ''}${m.lastError ? `<small class="err">${esc(m.lastError)}</small>` : ''}`, `${money(m.usdPerHour, 'US$')}/h`, money(m.costUsd, 'US$'),
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
      `<b>${esc(keyName(k))}</b>`, esc(k.role), `${k.source === 'env' ? 'variável' : 'emitida'}${k.createdAt ? `<small>desde ${esc(k.createdAt.slice(0, 10))}</small>` : ''}${k.expiresAt ? `<small>expira ${esc(k.expiresAt.slice(0, 10))}</small>` : ''}`, gpuPolicy(k),
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

function appCell(id: string, profile: AppProfile | null, needs: string): string {
  const { name, description } = appTitle(id, profile);
  return `<b><a href="/admin?app=${encodeURIComponent(id)}#apps">${esc(name)}</a></b>`
    + (name !== id ? ` <span class="mono">${esc(id)}</span>` : '')
    + `<small>${description ? esc(description) : 'sem descrição · defina em PUT /v1/apps/' + esc(id) + '/profile'}</small>`
    + `<small>${esc(needs)} · <a href="#garantia-${esc(id)}">como o serviço é garantido</a></small>`;
}

function apps(ctx: Ctx): Section {
  const { s, app: filter } = ctx;
  const ledger = s.spend ? spendWindow(ctx).slice(-2) : null;
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
      (budget ? `${count(budget.requests.used)}<small>de ${limitText(budget.requests.limit)}</small>` : '0')
        + (ledger ? `<small>${arrow(ledger[1]!.apps[id]?.requests ?? 0, ledger[0]!.apps[id]?.requests ?? 0)} ontem ${count(ledger[0]!.apps[id]?.requests ?? 0)}</small>` : '')
        + (budget ? meter(budget.requests.used, budget.requests.limit, reqLevel) : ''),
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
  'admin-page.login': 'entrou no painel', 'admin-page.park': 'estacionou a GPU', 'admin-page.probe': 'testou as reservas', 'admin-page.dismiss': 'ocultou recomendação',
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

function sections(ctx: Ctx, recos: Recommendation[]): Section[] {
  if (ctx.view) return [recoSection(ctx, recos), guarantee(ctx), apps(ctx), spend(ctx), gpus(ctx), reserves(ctx), keys(ctx), alerts(ctx), activity(ctx)];
  return [recoSection(ctx, recos), guarantee(ctx), traffic(ctx), spend(ctx), apps(ctx), gpus(ctx), reserves(ctx), balances(ctx), keys(ctx), machines(ctx), alerts(ctx), activity(ctx)];
}

interface Kpi { label: string; href: string; value: string; sub: string; level: Level | null }

const arrow = (now: number, before: number) => (now > before * 1.05 ? '▲' : now < before * 0.95 ? '▼' : '=');

function gpuToday(ctx: Ctx, keySpend: number, fallback: string): Kpi {
  if (!ctx.s.spend) return { label: 'Gasto GPU hoje', href: '#chaves', value: money(keySpend), sub: fallback, level: null };
  const days = spendWindow(ctx).slice(-8);
  const total = (d: (typeof days)[number]) => Object.values(d.apps).reduce((a, e) => a + e.gpuEur, 0);
  const today = total(days.at(-1)!);
  const yesterday = total(days.at(-2)!);
  const week = days.slice(1).reduce((a, d) => a + total(d), 0);
  return { label: 'Gasto GPU hoje', href: '#gastos', value: money(today), sub: `${arrow(today, yesterday)} ontem ${money(yesterday)} · 7 d ${money(week)}`, level: null };
}

function booting(gpus: DeploymentView[]): string {
  const n = gpus.filter(d => bootOf(d)).length;
  const stuck = gpus.filter(d => bootOf(d)?.stuck).length;
  return (n ? ` · ${n} iniciando` : '') + (stuck ? ` · ${stuck} travada${stuck > 1 ? 's' : ''}` : '');
}

function kpis(ctx: Ctx, all: Section[]): Kpi[] {
  const { s, view } = ctx;
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
    {
      label: 'GPUs ligadas', href: '#gpus', value: s.gpus ? `${on.length} de ${s.gpus.length}` : '—', level: levelOf('gpus'),
      sub: s.gpus ? `${money(perHour)}/h agora${booting(s.gpus)}` : 'GPUs desligadas aqui',
    },
    gpuToday(ctx, keySpend, g ? `máquinas ${money(g.dayUsd, 'US$')}/24 h` : 'pedida por chaves'),
    shortest
      ? { label: 'Menor saldo', href: '#saldos', value: `${money(shortest.balanceUsd, unitOf(shortest))}`, sub: `${shortest.provider}${shortest.hoursLeft !== null ? ` · ~${count(Math.round(shortest.hoursLeft))} h` : ''}`, level: levelOf('saldos') }
      : { label: 'Reservas', href: '#reservas', value: `${reservesOk} de ${s.reserves.links.length}`, sub: 'respondendo', level: levelOf('reservas') },
  ];
}

const RECOS_IN_OVERVIEW = 3;

function recoSummary(recos: Recommendation[]): string {
  if (!recos.length) return '';
  const top = recos.slice(0, RECOS_IN_OVERVIEW).map(r => `<li>${mark(r.level)}<a href="#recomendacoes">${esc(r.title)}</a>${
    r.impact ? `<span class="amt">${esc(r.impact.text)}</span>` : ''}</li>`).join('');
  return `<div class="rsum"><h3 class="sub">Recomendações <span class="t">${recos.length > RECOS_IN_OVERVIEW ? `${RECOS_IN_OVERVIEW} de ${recos.length} · ` : ''}`
    + `<a href="#recomendacoes">ver todas</a></span></h3><ul>${top}</ul></div>`;
}

function statusBar(s: AdminSnapshot, now: number, time: string): string {
  const a = s.about;
  const fresh = (label: string, iso: string | null) => `<span>${label} ${iso ? esc(ago(iso, now)) : 'sem leitura'}</span>`;
  const up = a ? duration(a.uptimeSeconds) : null;
  return `<footer class="bar" aria-label="Estado do gateway">${a ? `<span>build <code>${esc(a.commit?.slice(0, 7) ?? '—')}</code></span><span>no ar há ${up}</span>` : ''}`
    + `${a?.region ? `<span>região ${esc(a.region)}</span>` : ''}<span>atualizado ${time}</span>`
    + `${s.traffic ? fresh('telemetria', a?.telemetryAt ?? null) : ''}${s.balances.length ? fresh('saldos', latest(s.balances.map(b => b.checkedAt))) : ''}`
    + `${fresh('reservas', latest(s.reserves.links.map(r => r.checkedAt)))}</footer>`;
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

export function renderGpuDetail(nonce: string, s: AdminSnapshot, name: string, now: number): string | null {
  const d = s.gpus?.find(g => g.name === name);
  if (!d) return null;
  return page(nonce, `ai-gateway · ${d.name}`, `<main class="main detail">${gpuDetailBody(d, s.gpuLogs?.[name] ?? [], now)}</main>`, true);
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
  const recos = recommendations(ctx);
  const all = sections(ctx, recos);
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
    + `${attn}<div class="kpis${view ? ' few' : ''}">${tiles}</div>${recoSummary(recos)}</div>`;
  const body = all.map(x => `<section id="${x.id}" data-spy><header class="sh"><h2>${esc(x.title)}</h2>${x.badge ?? pill(x.level, LEVEL_TEXT[x.level])}${
    x.meta ? `<span class="meta">${esc(x.meta)}</span>` : ''}${x.actions ? `<div class="acts">${x.actions}</div>` : ''}</header>${x.body}</section>`).join('');
  return page(nonce, `ai-gateway · ${own ? `${own.name} · ` : ''}${HEADLINE[overall]}`, `<div class="shell">${side}<main class="main">${
    opts.message ? `<p class="msg" role="status">${esc(opts.message)}</p>` : ''}${overview}${body}${statusBar(s, opts.now, time)}</main></div>`, true);
}
