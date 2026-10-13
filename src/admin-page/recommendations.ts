import type { DeploymentView } from '../deployments/types';
import { idleGpu } from '../deployments/idle';
import type { AdminSnapshot } from './render';
import { spendWindow } from './spend';
import {
  NEAR_LIMIT, appTitle, count, duration, esc, form, hhmm, mark, money, ms, pct, stageName, upOf, outsideWindow, type Ctx, type Level, type Section,
} from './ui';

export interface Recommendation {
  id: string;
  level: Level;
  title: string;
  saw: string;
  why: string;
  impact: { amount: number; unit: '€' | 'US$'; text: string } | null;
  action: { park: string } | { probe: true } | { text: string } | { go: string; label: string };
}

const IDLE_TAIL_TARGET_MIN = 15;
const BALANCE_DAYS = 7;
const TURN_TARGET_MS = 1500;
const FALLBACK_SHARE = 0.5;
const FALLBACK_MIN_CALLS = 20;
const TREND_FACTOR = 1.5;
const UNUSED_DAYS = 30;

const perHourOf = (d: DeploymentView) => upOf(d).reduce((a, r) => a + (r.pricePerHour ?? 0), 0);
const minutesSince = (iso: string | null, now: number) => (iso ? (now - Date.parse(iso)) / 60_000 : Infinity);
const windowText = (d: DeploymentView) => (d.spec.warmSchedule ?? []).map(w => `${w.start}–${w.end}`).filter((v, i, a) => a.indexOf(v) === i).join(', ');

function gpuRules(s: AdminSnapshot, now: number): Recommendation[] {
  const out: Recommendation[] = [];
  for (const d of s.gpus ?? []) {
    const up = upOf(d);
    const perHour = perHourOf(d);
    const age = Math.max(0, ...up.map(r => r.ageSeconds));
    if (up.length && outsideWindow(d, now)) {
      out.push({
        id: `gpu-outside:${d.name}`, level: 'warn', title: `${d.name} ligada fora da janela de aula`,
        saw: `${up.length} réplica(s) ligada(s) há ${duration(age)} · janela ${windowText(d)} · último pedido ${d.lastRequestAt ? hhmm(d.lastRequestAt) : 'nenhum'}`,
        why: 'Fora da janela ninguém deveria precisar dela; cada hora ligada é paga inteira.',
        impact: { amount: perHour, unit: '€', text: `${money(perHour)}/h enquanto ficar ligada` }, action: { park: d.name },
      });
    }
    const idle = idleGpu(d, now);
    if (idle && !outsideWindow(d, now)) {
      out.push({
        id: `gpu-idle:${d.name}`, level: 'warn', title: `${d.name} ligada sem uso`,
        saw: `${up.length} réplica(s) · sem pedido há ${Math.round(idle.minutes)} min (limite ${idle.limitMinutes} min) · ${money(idle.wastedEur)} gastos · ligada há ${duration(age)}`,
        why: 'Sem pedidos e sem janela de aula, a GPU só gasta.',
        impact: { amount: perHour, unit: '€', text: `${money(perHour)}/h enquanto ficar ligada` }, action: { park: d.name },
      });
    }
    const idleSpec = d.spec.idleMinutes;
    const price = perHour || (d.spec.maxEurPerHour ?? 0);
    if (typeof idleSpec === 'number' && idleSpec > IDLE_TAIL_TARGET_MIN && d.spec.minReplicas === 0 && price > 0) {
      const tail = ((idleSpec - IDLE_TAIL_TARGET_MIN) / 60) * price;
      out.push({
        id: `idle-tail:${d.name}`, level: 'ok', title: `${d.name} espera ${idleSpec} min antes de desligar`,
        saw: `idleMinutes ${idleSpec} · ${perHour ? `${money(perHour)}/h agora` : `até ${money(price)}/h (maxEurPerHour)`}`,
        why: `Depois do último pedido a réplica fica ligada ${idleSpec} min; ${IDLE_TAIL_TARGET_MIN} min cobrem uma pausa de aula.`,
        impact: { amount: tail, unit: '€', text: `~${money(tail)} a cada vez que o uso termina` },
        action: { text: `PATCH /v1/deployments/${d.name} {"idleMinutes": ${IDLE_TAIL_TARGET_MIN}}` },
      });
    }
    const unusedMin = minutesSince(d.lastRequestAt, now);
    if (!up.length && !d.spec.warmSchedule?.length && unusedMin >= UNUSED_DAYS * 1440) {
      out.push({
        id: `deployment-unused:${d.name}`, level: 'ok', title: `${d.name} sem uso`,
        saw: d.lastRequestAt ? `último pedido há ${Math.round(unusedMin / 1440)} d` : 'nenhum pedido registrado pelo gateway',
        why: 'Um deployment esquecido pode ser acordado por engano e confunde quem lê o painel.',
        impact: null, action: { text: `DELETE /v1/deployments/${d.name}` },
      });
    }
  }
  return out;
}

function keyRules(s: AdminSnapshot): Recommendation[] {
  const out: Recommendation[] = [];
  const spent = s.gpuSpend?.spentEur ?? {};
  for (const k of s.keys.filter(k => k.active && !k.admin)) {
    const cap = k.policy.gpuDailyEur;
    const eur = spent[k.id] ?? 0;
    const name = `${k.user}${k.label ? ` (${k.label})` : ''}`;
    if (k.policy.canStartGpu && cap === null) {
      out.push({
        id: `keycap-none:${k.user}.${k.label ?? ''}`, level: 'warn', title: `Chave ${name} liga GPU sem teto diário`,
        saw: `canStartGpu ligado · gpuDailyEur vazio · ${money(eur)} hoje`,
        why: 'Uma chave vazada ou um laço no app pode manter GPUs ligadas o dia todo sem limite.',
        impact: null, action: { text: `PUT /v1/admin/access/keys/policy {"id": "<id de ${name}>", "gpuDailyEur": 10}` },
      });
    }
    if (cap && eur >= cap * NEAR_LIMIT) {
      out.push({
        id: `keycap-near:${k.user}.${k.label ?? ''}`, level: eur >= cap ? 'bad' : 'warn', title: `Chave ${name} perto do teto de GPU`,
        saw: `${money(eur)} de ${money(cap)} hoje (${pct(eur / cap)})`,
        why: 'Ao bater o teto a chave não liga mais GPU até a meia-noite.',
        impact: null, action: { text: `PUT /v1/admin/access/keys/policy {"id": "<id de ${name}>", "gpuDailyEur": ${Math.ceil(cap * 1.5)}}` },
      });
    }
  }
  for (const b of s.appBudgets) {
    for (const [what, use] of [['pedidos', b.requests], ['tokens', b.tokens]] as const) {
      if (!use.limit || use.used < use.limit * NEAR_LIMIT) continue;
      out.push({
        id: `app-budget:${b.app}:${what}`, level: use.used >= use.limit ? 'bad' : 'warn', title: `${appTitle(b.app, s.apps.find(a => a.id === b.app)?.profile).name} perto do limite diário de ${what}`,
        saw: `${count(use.used)} de ${count(use.limit)} ${what} (${pct(use.used / use.limit)}) · ${count(Math.round(use.perMinute * 10) / 10)}/min · zera às ${hhmm(b.resetAt)}`,
        why: 'Ao esgotar, o app recebe 429 até zerar.',
        impact: null, action: { text: `PUT /v1/apps/${b.app}/limits {"${what === 'pedidos' ? 'dailyRequests' : 'dailyTokens'}": ${Math.ceil(use.limit * 1.5)}}` },
      });
    }
  }
  return out;
}

function serviceRules(s: AdminSnapshot): Recommendation[] {
  const out: Recommendation[] = [];
  for (const r of s.reserves.links.filter(r => !r.ok)) {
    out.push({
      id: `reserve-failed:${r.stage}:${r.target}`, level: 'bad', title: `Reserva de ${stageName(r.stage)} não respondeu`,
      saw: `${r.target} · ${r.code ?? r.status ?? 'sem código'}${r.error ? ` · ${r.error}` : ''} · ${ms(r.latencyMs)}`,
      why: 'Se a GPU cair, esta etapa fica sem resposta: a reserva é a rede de segurança.',
      impact: null, action: { probe: true },
    });
  }
  for (const b of s.balances) {
    if (b.balanceUsd === null || b.hoursLeft === null || b.hoursLeft >= BALANCE_DAYS * 24) continue;
    const need = Math.max(0, (b.burnPerHour ?? 0) * BALANCE_DAYS * 24 - b.balanceUsd);
    const unit = b.currency === 'EUR' ? '€' : 'US$';
    out.push({
      id: `balance-low:${b.provider}`, level: b.hoursLeft < 48 ? 'bad' : 'warn', title: `Saldo ${b.provider} acaba em ~${Math.round(b.hoursLeft)} h`,
      saw: `${money(b.balanceUsd, unit)} · ${money(b.burnPerHour, unit)}/h`,
      why: 'Sem saldo o provedor recusa os pedidos e as máquinas param.',
      impact: { amount: need, unit, text: `faltam ~${money(need, unit)} para ${BALANCE_DAYS} dias` },
      action: { text: `recarregar no painel do ${b.provider}` },
    });
  }
  const t = s.traffic;
  if (t) {
    const p50 = (key: string) => t.stages.find(l => l.key === key)?.p50Ms ?? null;
    const parts = [p50('stt'), p50('chat') ?? p50('llm'), p50('tts')];
    if (parts.every(v => v !== null)) {
      const turn = parts.reduce((a, b) => a! + b!, 0)!;
      if (turn > TURN_TARGET_MS) {
        out.push({
          id: 'turn-latency', level: 'warn', title: 'Turno de voz acima da meta',
          saw: `fala → texto ${ms(parts[0])} + conversa ${ms(parts[1])} + texto → fala ${ms(parts[2])} = ${ms(turn)} (p50, 24 h)`,
          why: `A meta do parle é 1–1,5 s por turno; acima disso a conversa parece travar.`,
          impact: null, action: { go: '/admin/servicos#trafego', label: 'Ver o tráfego por etapa' },
        });
      }
    }
    for (const l of t.stages) {
      const calls = l.served + l.failed;
      if (l.p95Ms !== null && l.p95Ms > TURN_TARGET_MS && calls >= FALLBACK_MIN_CALLS) {
        out.push({
          id: `stage-p95:${l.key}`, level: 'warn', title: `${stageName(l.key)} lenta no p95`,
          saw: `p95 ${ms(l.p95Ms)} · p50 ${ms(l.p50Ms)} · ${count(calls)} chamadas em 24 h`,
          why: 'Uma em cada vinte respostas sozinha já passa do turno inteiro.',
          impact: null, action: { go: '/admin/servicos#trafego', label: 'Ver o tráfego por provedor' },
        });
      }
      if (calls >= FALLBACK_MIN_CALLS && l.fallbacks / calls >= FALLBACK_SHARE) {
        out.push({
          id: `stage-fallback:${l.key}`, level: 'bad', title: `${stageName(l.key)} servida pela reserva na maior parte do tempo`,
          saw: `${count(l.fallbacks)} desvios em ${count(calls)} chamadas (${pct(l.fallbacks / calls)})`,
          why: 'A GPU desta etapa está paga mas não responde: a rota para ela pode estar quebrada.',
          impact: null, action: { go: '/admin/gpus', label: 'Conferir as GPUs' },
        });
      }
    }
  }
  return out;
}

function appRules(s: AdminSnapshot): Recommendation[] {
  const out: Recommendation[] = [];
  for (const a of s.apps) {
    if (a.status?.mode === 'degraded') {
      const deps = (s.gpus ?? []).filter(d => a.status!.deployments.some(x => x.name === d.name) && upOf(d).length);
      const perHour = deps.reduce((sum, d) => sum + perHourOf(d), 0);
      if (deps.length) {
        out.push({
          id: `app-degraded-gpu:${a.id}`, level: 'bad', title: `${appTitle(a.id, a.profile).name} na reserva com GPU ligada`,
          saw: `${deps.map(d => d.name).join(', ')} ligada(s) · app servindo pela nuvem${a.status.fallback.since ? ` desde ${hhmm(a.status.fallback.since)}` : ''}`,
          why: 'A GPU está paga mas não atende; ou ela está com defeito, ou pode ser estacionada.',
          impact: { amount: perHour, unit: '€', text: `${money(perHour)}/h pagos sem uso` }, action: { park: deps[0]!.name },
        });
      }
    }
    if (!a.profile?.name || !a.profile?.description) {
      out.push({
        id: `app-unnamed:${a.id}`, level: 'ok', title: `${a.id} sem nome ou descrição no perfil`,
        saw: a.profile ? `perfil sem ${[!a.profile.name && 'name', !a.profile.description && 'description'].filter(Boolean).join(' e ')}` : 'app sem perfil',
        why: 'Sem nome, o painel e os alertas mostram só o identificador.',
        impact: null, action: { text: `PUT /v1/apps/${a.id}/profile {"name": "…", "description": "…"}` },
      });
    }
  }
  return out;
}

function trendRules(ctx: Ctx): Recommendation[] {
  if (!ctx.s.spend) return [];
  const days = spendWindow(ctx).slice(-8);
  const today = days.at(-1)!.apps;
  const out: Recommendation[] = [];
  for (const app of Object.keys(today)) {
    const prev = days.slice(0, 7).filter(d => d.apps[app]).map(d => d.apps[app]!.gpuEur);
    if (prev.length < 3) continue;
    const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
    const now = today[app]!.gpuEur;
    if (avg <= 0 || now < avg * TREND_FACTOR) continue;
    out.push({
      id: `spend-trend:${app}`, level: 'warn', title: `${appTitle(app, ctx.s.apps.find(a => a.id === app)?.profile).name} gastando acima do normal`,
      saw: `GPU hoje ${money(now)} · média de ${prev.length} dias ${money(avg)} (${pct(now / avg - 1)} acima)`,
      why: 'Um salto no gasto costuma ser uma GPU esquecida ou uma janela de aula mal configurada.',
      impact: { amount: now - avg, unit: '€', text: `${money(now - avg)} acima da média hoje` }, action: { go: '/admin/gastos', label: 'Ver os gastos por dia' },
    });
  }
  return out;
}

const RANK: Record<Level, number> = { bad: 0, warn: 1, ok: 2 };
const IMPACT_RANK = { '€': 0, 'US$': 1, none: 2 };

export function recommendations(ctx: Ctx): Recommendation[] {
  const dismissed = ctx.s.dismissed ?? {};
  return [...gpuRules(ctx.s, ctx.now), ...keyRules(ctx.s), ...serviceRules(ctx.s), ...appRules(ctx.s), ...trendRules(ctx)]
    .filter(r => !(dismissed[r.id] && dismissed[r.id]! > ctx.now))
    .sort((a, b) => IMPACT_RANK[a.impact?.unit ?? 'none'] - IMPACT_RANK[b.impact?.unit ?? 'none'] || (b.impact?.amount ?? 0) - (a.impact?.amount ?? 0) || RANK[a.level] - RANK[b.level]);
}

function actionOf(r: Recommendation, ctx: Ctx): string {
  const { csrf, view } = ctx;
  if ('park' in r.action) {
    const own = !view || (view.canPark && ctx.s.gpus?.find(d => d.name === (r.action as { park: string }).park)?.app === view.id);
    return own ? form('/admin/park', csrf, 'Estacionar', `Estacionar ${r.action.park}?`, { name: r.action.park }, 'danger', ctx.path)
      : `<code>${esc(`estacionar ${r.action.park}`)}</code>`;
  }
  if ('go' in r.action) return `<a class="btn" href="${esc(r.action.go)}">${esc(r.action.label)}</a>`;
  if ('probe' in r.action) return view ? '<span class="t">peça ao admin para testar as reservas</span>' : form('/admin/probe', csrf, 'Testar as reservas', '', {}, '', ctx.path);
  return `<code>${esc(r.action.text)}</code>`;
}

const recoItem = (r: Recommendation, ctx: Ctx) => `<li class="reco ${r.level}">${mark(r.level)}<div class="rb"><div class="rt"><b>${esc(r.title)}</b>${
  r.impact ? `<span class="amt">${esc(r.impact.text)}</span>` : ''}</div>`
  + `<details><summary>O que vimos e por quê</summary><dl><dt>Visto</dt><dd>${esc(r.saw)}</dd><dt>Por quê</dt><dd>${esc(r.why)}</dd></dl></details>`
  + `<div class="ra">${actionOf(r, ctx)}${ctx.view ? '' : form('/admin/dismiss', ctx.csrf, 'Ocultar 7 dias', '', { id: r.id }, 'quiet', ctx.path)}</div></div></li>`;

function badgeOf(urgent: Recommendation[]): string {
  const bad = urgent.filter(r => r.level === 'bad').length;
  if (bad) return `<span class="pill bad">${bad === 1 ? '1 urgente' : `${count(bad)} urgentes`}</span>`;
  return `<span class="pill info">${!urgent.length ? 'nada urgente' : urgent.length === 1 ? '1 a revisar' : `${count(urgent.length)} a revisar`}</span>`;
}

export function recoSection(ctx: Ctx, list: Recommendation[]): Section {
  const urgent = list.filter(r => r.level !== 'ok').sort((a, b) => RANK[a.level] - RANK[b.level]);
  const tidy = list.filter(r => r.level === 'ok');
  const idleWaste = list.filter(r => r.impact?.unit === '€' && r.id.startsWith('gpu-')).reduce((a, r) => a + r.impact!.amount, 0);
  const more = tidy.length
    ? `<details class="more"${urgent.length ? '' : ' open'}><summary>${tidy.length === 1 ? '1 sugestão de economia e arrumação' : `${count(tidy.length)} sugestões de economia e arrumação`}</summary>`
      + `<ul class="recos">${tidy.map(r => recoItem(r, ctx)).join('')}</ul></details>` : '';
  return {
    id: 'recomendacoes', title: 'O que fazer', count: urgent.length, actions: '', level: 'ok', info: true,
    badge: badgeOf(urgent),
    notes: urgent.map(r => r.title),
    meta: `${idleWaste ? `${money(idleWaste)}/h em GPU sem uso · ` : ''}€ primeiro, depois risco`,
    body: list.length ? `${urgent.length ? `<ul class="recos">${urgent.map(r => recoItem(r, ctx)).join('')}</ul>` : ''}${more}`
      : '<p class="empty">Nada a fazer agora: nenhuma regra disparou com os dados atuais.</p>',
  };
}
