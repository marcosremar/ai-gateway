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
import { GPU_CAP_RULE, gpuCapRule, SCALEWAY_GPU_OFF } from '../deployments/spec';
import { answeredShare, gpuShare, sloLevel, type AdminTraffic, type TrafficLine, type TrafficView } from './traffic';
import { SLO_TARGETS } from '../alerting/slo-targets';
import type { SpendLedgerView } from '../deployments/spend-ledger';
import { spend, spendWindow } from './spend';
import { parisMidnightAfter } from '../deployments/spend-ledger';
import { EUR_TO_USD } from '../deployments/vast-backend';
import { guarantee } from './guarantee';
import { bootHeadline, bootLevel, bootOf, bootState, detailHref, nextStep } from './boot';
import type { BootLogLine } from '../deployments/boot-track';
import type { ChainReport } from '../config/stage-chains';
import { recommendations, recoSection, type Recommendation } from './recommendations';
import { digestBlock, type DigestStatus } from './digest';
import type { Overspend } from '../telemetry/overspend';
import type { Promotion } from '../gateway/proxy/link-reorder';
import type { TtsCacheStats } from '../gateway/proxy/tts-cache';
import type { ModelRoutesSpec } from '../config/serve-providers';
import type { ModelPrices } from './model-prices';
import { voiceCache } from './voice-cache';
import { classSection } from './class-card';
import { incidentsSection } from './incidents';
import type { Incident } from '../telemetry/incidents';
import type { VoiceTurn } from '../app-telemetry/voice-turn';
import {
  ACTIVITY_SHOWN, ALERT_FRESH_MS, LEVEL_TEXT, appTitle, inClass, byLevel, count, duration, esc, form, hhmm, hour, latest, meter, ms, money, outsideWindow, pct, pill,
  pinBadge, plural, providerLabel, providerOf, ratioLevel, stageName, table, upOf, when, worst, type Ctx, type Level, type Section,
} from './ui';

export interface AdminAlert { event: string; at: string; summary: string }

export interface AdminApp { id: string; profile: AppProfile | null; status: AppStatus | null; aliases?: string[]; stages?: Record<string, string[]>; routes?: ModelRoutesSpec }

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
  digest?: DigestStatus | null;
  overspend?: Overspend[];
  reorders?: Promotion[];
  ttsCache?: TtsCacheStats | null;
  modelPrices?: ModelPrices | null;
  voiceTurns?: VoiceTurn[] | null;
  incidents?: Incident[] | null;
}

export interface AdminAbout { commit: string | null; uptimeSeconds: number; region: string | null; telemetryAt: string | null }



function reserves({ s, now, csrf, view, path }: Ctx): Section {
  const links = s.reserves.links;
  const failed = links.filter(r => !r.ok);
  const rows = [...links].sort((a, b) => Number(a.ok) - Number(b.ok) || Number(b.content === 'mismatch') - Number(a.content === 'mismatch')).map(r => [
    `<b>${esc(stageName(r.stage))}</b>`,
    `<code>${esc(r.target)}</code>${r.voice ? `<small>voz ${esc(r.voice)}</small>` : ''}`,
    !r.ok ? `${pill('bad', `falhou${r.code ? ` · ${r.code}` : ''}`)}${r.error ? `<small class="err">${esc(r.error)}</small>` : ''}`
      : r.content === 'mismatch' ? `${pill('warn', 'respondeu, conteúdo estranho')}<small class="err">${esc(r.contentNote ?? '')}</small>`
        : `${pill('ok', 'respondeu')}${r.content === 'ok' ? '<small>conteúdo conferido</small>' : ''}`,
    ms(r.latencyMs),
    when(r.checkedAt, now),
  ]);
  const odd = links.filter(r => r.ok && r.content === 'mismatch');
  const level: Level = !links.length ? 'warn' : failed.length ? 'bad' : odd.length ? 'warn' : 'ok';
  const checked = latest(links.map(r => r.checkedAt));
  return {
    id: 'reservas', title: 'Reservas', level, count: links.length,
    notes: !links.length ? ['nenhuma reserva testada ainda'] : failed.length ? [`${failed.map(r => stageName(r.stage)).join(', ')} sem resposta na nuvem`]
      : odd.length ? [`${odd.map(r => stageName(r.stage)).join(', ')}: a reserva responde, mas o conteúdo não confere`] : [],
    meta: `teste a cada ${s.reserves.intervalMinutes} min${checked ? ` · último às ${hhmm(checked)}` : ''}`,
    actions: view ? '' : form('/admin/probe', csrf, 'Testar agora', 'Testar todas as reservas agora? Cada uma recebe um pedido mínimo real.', {}, '', path),
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
    notes: [...s.providerCredit.map(c => `${c.provider} sem crédito`), ...s.balances.filter(r => r.level !== 'ok').map(r => `${r.provider}: ${r.reasons[0] ?? r.error ?? 'atenção'}`)],
    meta: checked ? `lidos às ${hhmm(checked)}` : 'ainda não lidos',
    actions: '',
    body: table([{ label: 'Provedor' }, { label: 'Estado' }, { label: 'Saldo', num: true }, { label: 'Ritmo', num: true }, { label: 'Autonomia', num: true }, { label: 'Lido', num: true }],
      all.map(x => x.cells), 'Nenhum saldo lido ainda.'),
  };
}

export const GPU_STATUS: Record<string, string> = { ready: 'pronta', 'scaled-to-zero': 'desligada', warming: 'ligando', degraded: 'com falha', paused: 'pausada' };
const keyName = (k: KeyView | undefined) => (k ? `${k.user}${k.label ? ` (${k.label})` : ''}` : 'chave removida');

function gpuCost(d: DeploymentView, eurPerHour: number, now: number): string {
  const today = (eurPerHour * Math.min(...upOf(d).map(r => r.ageSeconds), (now - (parisMidnightAfter(now) - 86_400_000)) / 1000)) / 3600;
  return providerOf(d) === 'vast'
    ? `${money(eurPerHour * EUR_TO_USD, 'US$')}/h<small>${money(eurPerHour)}/h · hoje ≈ ${money(today * EUR_TO_USD, 'US$')}</small>`
    : `${money(eurPerHour)}/h<small>hoje ≈ ${money(today)}</small>`;
}

export const pinForm = (d: DeploymentView, csrf: string, back?: string) => (d.pinned
  ? form('/admin/pin', csrf, 'Soltar', `Soltar ${d.name}? Ela volta a desligar após ${d.spec.idleMinutes} min sem uso.`, { name: d.name, on: '0' }, 'quiet', back)
  : form('/admin/pin', csrf, 'Fixar', `Fixar ${d.name}? Uma réplica fica ligada e só estaciona após 1 h sem pedido.`, { name: d.name, on: '1' }, 'quiet', back));

export const parkForm = (d: DeploymentView, csrf: string, back?: string) =>
  form('/admin/park', csrf, 'Estacionar', `Estacionar ${d.name}? As réplicas sem uso desligam; pedidos em curso terminam.`, { name: d.name }, 'danger', back);

export const gpuActions = (d: DeploymentView, { csrf, view, path }: Ctx) => [
  upOf(d).length && (!view || (view.canPark && d.app === view.id)) ? parkForm(d, csrf, path) : '',
  !view && providerOf(d) === 'vast' ? pinForm(d, csrf, path) : '',
].join('');

function gpuSlots(gpus: DeploymentView[]): string {
  const ladder = gpus.filter(d => !d.spec.paused && d.spec.provider === 'vast')
    .flatMap(d => d.spec.candidates?.map(c => c.machineType) ?? [d.spec.machineType]);
  const holders = gpus.filter(d => upOf(d).length).map(d => `${d.app ?? d.name}: ${d.name}`);
  const waiting = gpus.filter(d => `${d.autoscale?.blockedBy ?? ''} ${d.lastError ?? ''}`.includes(GPU_CAP_RULE)).map(d => d.name);
  return `<p class="filter">${esc(gpuCapRule([...new Set(ladder)]))} · ${esc(holders.join(' · ') || 'nenhuma GPU ligada')}`
    + `${waiting.length ? ` · à espera: ${esc(waiting.join(', '))}` : ''}</p>`;
}

function gpus(ctx: Ctx): Section {
  const { s, now } = ctx;
  const base = { id: 'gpus', title: 'GPUs', actions: '' };
  if (!s.gpus) return { ...base, level: 'ok', notes: [], count: null, meta: '', body: '<p class="empty">As GPUs gerenciadas estão desligadas neste gateway.</p>' };
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
      gpuActions(d, ctx),
    ] };
  }).sort(byLevel);
  const on = s.gpus.filter(d => upOf(d).length);
  const perHour = on.flatMap(upOf).reduce((sum, r) => sum + (r.pricePerHour ?? 0), 0);
  const level = worst(rows.map(r => r.level));
  return {
    ...base, level, count: s.gpus.length,
    notes: s.gpus.map((d) => {
      const boot = bootOf(d);
      if (boot) return `${d.name}: ${bootHeadline(boot)}`;
      const idle = idleGpu(d, now);
      if (idle) return `${d.name} ligada sem uso há ${Math.round(idle.minutes)} min: ${money(idle.wastedEur)} gastos, ${money(idle.eurPerHour)}/h`;
      if (outsideWindow(d, now)) return `${d.name} ligada fora da janela de aula`;
      return d.status === 'degraded' || d.lastError ? `${d.name} ${GPU_STATUS[d.status] ?? d.status}` : '';
    }).filter(Boolean),
    meta: `${SCALEWAY_GPU_OFF}: GPUs só na Vast · ${on.length} de ${s.gpus.length} ligadas · ${money(perHour)}/h agora`,
    body: gpuSlots(s.gpus) + table([
      { label: 'Deployment' }, { label: 'Estado' }, { label: 'Réplicas', num: true }, { label: 'Máquina', wide: true }, { label: 'Custo', num: true },
      { label: 'Ligada há', num: true, wide: true }, { label: 'Último pedido', num: true }, { label: 'Ligada por', wide: true }, { label: 'Ação', act: true },
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
    id: 'alertas', title: 'Alertas enviados', level: fresh.length ? 'warn' : 'ok', count: s.alerts.length, info: true,
    notes: fresh.length ? [`${plural(fresh.length, 'alerta', 'alertas')} na última hora`] : [],
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
  if (!s.machines) return { ...base, level: 'ok', notes: [], count: null, meta: '', body: '<p class="empty">As máquinas avulsas estão desligadas neste gateway.</p>' };
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
    ...base, level, count: live.length, notes: g && level !== 'ok' ? [`máquinas avulsas: gasto de 24 h em ${pct(g.dayUsd / g.capDayUsd)} do teto`] : [],
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
    notes: active.filter(k => ratioLevel(spent[k.id] ?? 0, k.policy.gpuDailyEur) !== 'ok').map(k => `${keyName(k)} perto do teto diário de GPU`),
    meta: `${active.length} ativas · GPU hoje ${money(Object.values(spent).reduce((a, b) => a + b, 0))}`,
    body: table([{ label: 'Chave' }, { label: 'Papel' }, { label: 'Origem', wide: true }, { label: 'GPU' }, { label: 'GPU hoje', num: true }, { label: 'Último uso', num: true }],
      all.map(r => r.cells), 'Nenhuma chave ativa.'),
  };
}

const MODE: Record<string, { level: Level; text: string }> = {
  gpu: { level: 'ok', text: 'na GPU' }, degraded: { level: 'warn', text: 'na reserva de nuvem' }, down: { level: 'bad', text: 'fora do ar' },
};
const arrow = (now: number, before: number) => (now > before * 1.05 ? '▲' : now < before * 0.95 ? '▼' : '=');
const expected = (mode: { level: Level; text: string }, outsideClass: boolean) => (outsideClass ? { level: 'ok' as Level, text: `${mode.text} · fora da aula` } : mode);
const limitText = (v: number | null | undefined) => (v ? count(v) : '∞');

function appCell(id: string, profile: AppProfile | null, needs: string): string {
  const { name, description } = appTitle(id, profile);
  return `<b><a href="/admin/servicos?app=${encodeURIComponent(id)}">${esc(name)}</a></b>`
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
    const mode = app?.status ? expected(MODE[app.status.mode]!, app.status.mode === 'degraded' && !inClass(s, id, ctx.now)) : null;
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
    notes: rows.filter(r => r.level !== 'ok').map(r => `${r.id} ${r.mode && r.mode.level !== 'ok' ? `servindo ${r.mode.text}` : 'perto do limite do dia'}`),
    meta: 'pedidos e tokens contados desde a meia-noite',
    body: (filter ? `<p class="filter">Só o app <b>${esc(filter)}</b> · <a href="${esc(ctx.path ?? '/admin/servicos')}">ver todos</a></p>` : '')
      + table([{ label: 'App' }, { label: 'Estado' }, { label: 'GPU' }, { label: 'Pedidos hoje', num: true }, { label: 'Ritmo', num: true, wide: true },
        { label: 'Tokens hoje', num: true, wide: true }, { label: 'Zera às', num: true, wide: true }], rows.map(r => r.cells), filter ? 'Nenhum app com esse nome.' : 'Nenhum app registrado.'),
  };
}

function chart(t: TrafficView): string {
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

function appTrafficRows(ctx: Ctx, t: AdminTraffic): Array<{ level: Level; cells: string[] }> {
  return (t.apps ?? []).map((l) => {
    const view = t.byApp?.[l.key];
    const calls = l.served + l.failed;
    const level = sloLevel(l);
    const gpu = view ? gpuShare(view) : null;
    return { level, cells: [
      `<b><a href="/admin/servicos?app=${encodeURIComponent(l.key)}#trafego">${esc(appTitle(l.key, ctx.s.apps.find(a => a.id === l.key)?.profile).name)}</a></b>`,
      count(calls),
      pill(level, pct(answeredShare(l) ?? 1)) + (l.failed ? `<small class="err">${count(l.failed)} sem resposta</small>` : ''),
      `${count(l.fallbacks)}${calls ? `<small>${pct(l.fallbacks / calls)} das chamadas</small>` : ''}`,
      gpu === null ? '—' : pct(gpu),
      ms(l.p50Ms), ms(l.p95Ms),
    ] };
  }).sort(byLevel);
}

function traffic(ctx: Ctx): Section {
  const { s } = ctx;
  const base = { id: 'trafego', title: 'Tráfego', actions: '' };
  const t = s.traffic;
  if (!t) return { ...base, level: 'ok', notes: [], count: null, meta: '', body: '<p class="empty">A telemetria está desligada neste gateway: sem contagem de chamadas nem latência.</p>' };
  const only = ctx.view?.id ?? ctx.app;
  const v = only ? t.byApp?.[only] ?? null : t;
  const scope = only && !ctx.view ? `<p class="filter">Só o app <b>${esc(only)}</b> · <a href="${esc(ctx.path ?? '/admin/servicos')}#trafego">ver todos</a></p>` : '';
  if (!v) return { ...base, level: 'ok', notes: [], count: null, meta: 'últimas 24 h', body: `${scope}<p class="empty">Nenhuma chamada deste app nas últimas 24 h.</p>` };
  const lastHourFailed = v.hours.at(-1)?.failed ?? 0;
  const perApp = only ? [] : appTrafficRows(ctx, t);
  const below = (t.apps ?? []).filter(l => !only && sloLevel(l) === 'bad');
  const level: Level = worst([lastHourFailed ? 'bad' : v.total.failed ? 'warn' : 'ok', ...perApp.map(r => r.level)]);
  const num = (label: string) => ({ label, num: true });
  const goal = pct(SLO_TARGETS.uptimeRatio);
  return {
    ...base, level, count: null,
    notes: [
      lastHourFailed ? `${plural(lastHourFailed, 'chamada', 'chamadas')} sem resposta na última hora` : v.total.failed ? `${plural(v.total.failed, 'chamada', 'chamadas')} sem resposta em 24 h` : '',
      ...below.map(l => `${appTitle(l.key, s.apps.find(a => a.id === l.key)?.profile).name} respondeu ${pct(answeredShare(l) ?? 1)} (meta ${goal})`),
    ].filter(Boolean),
    meta: `últimas 24 h · telemetria do gateway · meta ${goal} respondidas`,
    body: scope + chart(v)
      + (perApp.length ? '<h3 class="sub">Por app</h3>'
        + table([{ label: 'App' }, num('Chamadas'), num('Respondidas'), num('Desvios p/ reserva'), num('Na GPU'), num('p50'), num('p95')],
          perApp.map(r => r.cells), '') : '')
      + '<h3 class="sub">Por etapa</h3>'
      + table([{ label: 'Etapa' }, num('Chamadas'), num('Sem resposta'), num('Desvios p/ reserva'), num('p50'), num('p95')],
        v.stages.map(l => lineCells(l, `<b>${esc(stageName(l.key))}</b>`, true)), 'Nenhuma chamada nas últimas 24 h.')
      + '<h3 class="sub">Por provedor</h3>'
      + table([{ label: 'Provedor' }, num('Servidas'), num('Tentativas falhas'), num('p50'), num('p95')],
        v.providers.map(l => lineCells(l, `<code>${esc(l.key)}</code>`, false)), 'Nenhuma chamada nas últimas 24 h.'),
  };
}

const AUDIT_TEXT: Record<string, string> = {
  'admin-page.login': 'entrou no painel', 'admin-page.digest': 'enviou o resumo de sugestões', 'admin-page.park': 'estacionou a GPU', 'admin-page.probe': 'testou as reservas', 'admin-page.dismiss': 'ocultou recomendação',
  'deployment-credentials.rotate': 'trocou credenciais de máquina', 'provider-keys.applied': 'aplicou chaves de provedor',
  created: 'criou', updated: 'alterou', deleted: 'apagou', delete: 'apagou', start: 'ligou', stop: 'desligou', reboot: 'reiniciou',
};
const EVENT_TEXT: Record<string, string> = {
  'replica.creating': 'criando réplica', 'replica.ready': 'réplica pronta', 'replica.create_failed': 'falha ao criar réplica',
  'replica.unhealthy': 'réplica sem resposta', 'replica.parked': 'réplica estacionada', 'replica.power_on': 'religando réplica estacionada',
  'replica.released': 'réplica liberada', 'replica.gone': 'réplica sumiu no provedor', 'autoscale.warm': 'janela de aquecimento',
  'provider.credit_exhausted': 'provedor sem crédito', 'provider.credit_back': 'crédito de volta',
  'provider.account_refused': 'provedor recusou criar: conta sem permissão', 'stage.on_fallback': 'etapa foi para a reserva',
  'stage.on_primary': 'etapa voltou ao principal', 'app.degraded': 'app servindo pela reserva',
  'replica.stuck_retry': 'boot travado: réplica liberada para nova tentativa', 'replica.stuck_retried': 'nova tentativa em outra oferta',
  'replica.stuck_exhausted': 'boot travado: novas tentativas esgotadas',
  'route.reorder': 'reserva reordenada: link equivalente promovido', 'route.reorder_reverted': 'reserva de volta à ordem declarada',
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
    id: 'atividade', title: 'Quem fez o quê', level: recentBad.length ? 'warn' : 'ok', count: null, actions: '', info: true,
    notes: recentBad.length ? [`${plural(recentBad.length, 'evento', 'eventos')} com falha na última hora`] : [],
    meta: 'quem fez o quê: painel, chaves e ciclo das GPUs',
    body: table([{ label: 'Quando' }, { label: 'Quem' }, { label: 'O quê' }, { label: 'Alvo', wide: true }, { label: 'Resultado' }], all.map(x => x.cells), 'Nenhuma atividade registrada.'),
  };
}

export function sectionsOf(ctx: Ctx, recos: Recommendation[]): Map<string, Section> {
  const list = [recoSection(ctx, recos, digestBlock(ctx)), apps(ctx), guarantee(ctx), reserves(ctx), traffic(ctx), spend(ctx), gpus(ctx), keys(ctx), incidentsSection(ctx), alerts(ctx), activity(ctx)];
  list.push(voiceCache(ctx));
  const aula = classSection(ctx);
  if (aula) list.push(aula);
  if (!ctx.view) list.push(balances(ctx), machines(ctx));
  return new Map(list.map(x => [x.id, x]));
}

export { recommendations, unitOf };
