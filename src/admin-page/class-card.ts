import type { DeploymentView } from '../deployments/types';
import {
  CLASS_GAP_MS, classSessions, turnStats, VOICE_TURN_ALERT, VOICE_TURN_CEILING_MS, VOICE_TURN_TARGET_MS, type ClassSession, type TurnStats, type VoiceTurn,
} from '../app-telemetry/voice-turn';
import { SLO_TARGETS } from '../alerting/slo-targets';
import { bootHeadline, bootOf } from './boot';
import {
  appTitle, classState, count, duration, esc, hhmm, LEVEL_TEXT, mark, ms, pct, pill, plural, stageName, table, upOf, worst, ZONE,
  type ClassState, type Ctx, type Level, type Section,
} from './ui';

const FAILURES_SHOWN = 5;
const GAUGE_MAX_MS = VOICE_TURN_ALERT.p95Ms;
const clock = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayMonth = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, day: '2-digit', month: '2-digit' });
const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, weekday: 'short' });

export const trafficOf = (ctx: Ctx) => (ctx.app ? ctx.s.traffic?.byApp?.[ctx.app] ?? null : ctx.s.traffic);

function gpuStateText(d: DeploymentView): string {
  const boot = bootOf(d);
  if (boot) return bootHeadline(boot).toLowerCase();
  const up = upOf(d);
  const ready = up.filter(r => r.phase === 'ready').length;
  return up.length ? (ready ? 'pronta' : 'ligando') : 'desligada';
}

const appName = (ctx: Ctx, d: DeploymentView) => (d.app ? appTitle(d.app, ctx.s.apps.find(a => a.id === d.app)?.profile).name : null);

function liveFacts(ctx: Ctx, state: ClassState): string[] {
  const lastHour = trafficOf(ctx)?.hours.at(-1);
  return [
    ...state.open.map(d => `${appName(ctx, d) ? `${appName(ctx, d)} · ` : ''}${d.name} ${gpuStateText(d)}`),
    state.open.length ? '' : 'nenhuma GPU na janela de aula',
    lastHour ? `${plural(lastHour.served + lastHour.failed, 'chamada', 'chamadas')} na última hora${lastHour.failed ? `, ${count(lastHour.failed)} sem resposta` : ''}` : '',
  ].filter(Boolean);
}

const failLevel = (s: TurnStats): Level => (s.okShare === null || s.okShare >= SLO_TARGETS.uptimeRatio ? 'ok' : 1 - s.okShare >= VOICE_TURN_ALERT.failShare ? 'bad' : 'warn');
const latencyLevel = (s: TurnStats): Level => (s.p95Ms === null || s.p95Ms <= VOICE_TURN_TARGET_MS ? 'ok' : s.p95Ms <= VOICE_TURN_CEILING_MS ? 'warn' : 'bad');
const degradedLevel = (s: TurnStats): Level => (s.degraded.length ? 'warn' : 'ok');
const healthOf = (s: TurnStats): Level => worst([failLevel(s), latencyLevel(s), degradedLevel(s)]);

function gauge(s: TurnStats): string {
  const x = (v: number) => Math.round((Math.min(v, GAUGE_MAX_MS) / GAUGE_MAX_MS) * 2000) / 10;
  const target = x(VOICE_TURN_TARGET_MS);
  const ceiling = x(VOICE_TURN_CEILING_MS);
  const tick = (v: number | null, cls: string, w: number, y: number) => (v === null ? ''
    : `<rect class="${cls}" x="${Math.max(0, Math.min(200 - w, x(v) - w / 2))}" y="${y}" width="${w}" height="${12 - 2 * y}"/>`);
  return `<svg class="lat" viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true"><rect class="z0" x="0" y="4" width="${target}" height="4"/>`
    + `<rect class="z1" x="${target}" y="4" width="${ceiling - target}" height="4"/><rect class="z2" x="${ceiling}" y="4" width="${200 - ceiling}" height="4"/>`
    + `${tick(s.p50Ms, 'p50', 2, 2)}${tick(s.p95Ms, 'p95', 3, 0)}</svg>`;
}

const seconds = (v: number) => `${String(v / 1000).replace('.', ',')} s`;

const tile = (label: string, value: string, note: string, level: Level = 'ok', extra = '') =>
  `<div><span>${esc(label)}</span><b class="${level}">${level === 'ok' ? '' : mark(level)}${value}</b>${extra}<small>${esc(note)}</small></div>`;

function tiles(s: TurnStats, first: { label: string; note: string }, okNote: string): string {
  return `<div class="stats turn">${tile(first.label, count(s.turns), first.note)}`
    + tile('Turnos ok', s.okShare === null ? '—' : pct(s.okShare), okNote, failLevel(s))
    + tile('Turno p50 · p95', `${ms(s.p50Ms)} · ${ms(s.p95Ms)}`, `meta ${seconds(VOICE_TURN_TARGET_MS)} · teto ${seconds(VOICE_TURN_CEILING_MS)}`, latencyLevel(s), gauge(s))
    + tile('Etapas degradadas', s.degraded.length ? s.degraded.map(d => stageName(d.stage)).join(', ') : 'nenhuma',
      s.degraded.length ? `${s.degraded.map(d => count(d.count)).join(' + ')} de ${count(s.turns)} turnos fora do caminho principal` : 'todas no caminho principal', degradedLevel(s))
    + '</div>';
}

const failure = (stage: string | null, reason: string | null) => `<b>${esc(stageName(stage ?? 'unknown'))}</b><small><code>${esc(reason ?? 'unknown')}</code></small>`;

function failureTable(session: TurnStats, recent: TurnStats | null): string {
  const cols = [{ label: 'Etapa e motivo' }, ...(recent ? [{ label: '10 min', num: true }] : []), { label: recent ? 'Na aula' : 'Turnos', num: true }];
  const rows = session.failures.map(f => [
    failure(f.stage, f.reason), ...(recent ? [count(recent.failures.find(r => r.stage === f.stage && r.reason === f.reason)?.count ?? 0)] : []), count(f.count),
  ]);
  return `<h3 class="sub">Falhas por etapa e motivo</h3><div class="cap">${table(cols, rows, 'Nenhuma falha.')}</div>`;
}

function lastFailures(turns: readonly VoiceTurn[]): string {
  const failed = turns.filter(t => !t.ok).sort((a, b) => b.at - a.at).slice(0, FAILURES_SHOWN);
  if (!failed.length) return '';
  return `<h3 class="sub">Últimas falhas</h3><div class="cap">${table([{ label: 'Hora' }, { label: 'Falha' }, { label: 'Request id' }], failed.map(t => [
    `<span class="mono">${esc(clock.format(t.at))}</span>`, failure(t.failedStage, t.reason), `<code class="rid">${esc(t.requestId)}</code>`,
  ]), '')}</div><p class="foot-note">O request id é o mesmo do log do gateway: procure-o lá para ver a chamada inteira.</p>`;
}

const notesOf = (s: TurnStats, where: string): string[] => [
  s.failed ? `aula: ${plural(s.failed, 'turno falhou', 'turnos falharam')} de ${count(s.turns)} ${where}` : '',
  latencyLevel(s) !== 'ok' ? `aula: p95 do turno ${ms(s.p95Ms)}, acima da meta de ${seconds(VOICE_TURN_TARGET_MS)}` : '',
  s.degraded.length ? `aula: ${s.degraded.map(d => d.stage).join(', ')} degradada` : '',
].filter(Boolean);

function live(ctx: Ctx, turns: readonly VoiceTurn[], current: ClassSession | null, state: ClassState): Section {
  const recent = turnStats(turns.filter(t => t.classWindow && t.at > ctx.now - VOICE_TURN_ALERT.windowMs && t.at <= ctx.now));
  const session = turnStats(current?.turns ?? []);
  const level = healthOf(recent);
  const body = !current
    ? '<p class="empty">Nenhum turno de voz recebido nesta aula ainda. O parle envia cada turno ao gateway (voice.turn) assim que o aluno fala.</p>'
    : tiles(recent, { label: 'Turnos em 10 min', note: `${count(session.turns)} desde ${hhmm(current.startedAt)}` },
      `${plural(recent.failed, 'falha', 'falhas')} em 10 min${session.okShare === null ? '' : ` · ${pct(session.okShare)} na aula`}`)
      + (session.failed ? failureTable(session, recent) + lastFailures(current.turns) : '');
  return {
    id: 'aula', title: `Aula em curso${state.endsAt ? ` · até ${hhmm(state.endsAt)}` : ''}`, level, count: null, actions: '',
    notes: notesOf(recent, 'em 10 min'), meta: liveFacts(ctx, state).join(' · '), body,
  };
}

function dayOf(at: number, now: number): string {
  const day = dayMonth.format(at);
  if (day === dayMonth.format(now)) return 'hoje';
  if (day === dayMonth.format(now - 86_400_000)) return 'ontem';
  return `${weekday.format(at).replace('.', '')} ${day}`;
}

function lastClass(ctx: Ctx, last: ClassSession): Section {
  const s = turnStats(last.turns);
  const level = healthOf(s);
  return {
    id: 'aula', title: 'Última aula', level, count: null, actions: '', info: true, notes: [],
    meta: `${dayOf(last.startedAt, ctx.now)} · ${hhmm(last.startedAt)}–${hhmm(last.endedAt)}`,
    body: tiles(s, { label: 'Turnos', note: `em ${duration((last.endedAt - last.startedAt) / 1000)} de aula` }, `${plural(s.failed, 'falha', 'falhas')} na aula`)
      + (s.failed ? `<details class="more"><summary>${plural(s.failed, 'falha', 'falhas')}: etapa, motivo e request id</summary>${failureTable(s, null) + lastFailures(last.turns)}</details>` : ''),
  };
}

export function classSection(ctx: Ctx): Section | null {
  const all = ctx.s.voiceTurns;
  if (!all) return null;
  const turns = (ctx.app ? all.filter(t => t.app === ctx.app) : all).filter(t => t.at <= ctx.now);
  const sessions = classSessions(turns);
  const last = sessions.at(-1) ?? null;
  const state = classState(ctx.s.gpus ?? [], ctx.now);
  const ongoing = last && ctx.now - last.endedAt < CLASS_GAP_MS ? last : null;
  if (state.open.length || (last && ctx.now - last.endedAt <= VOICE_TURN_ALERT.windowMs)) return live(ctx, turns, ongoing, state);
  return last ? lastClass(ctx, last) : null;
}

function cardHtml(x: Section, isLive: boolean): string {
  return `<section id="${x.id}" class="turns ${isLive ? `on ${x.level}` : x.level}"><header class="sh">${isLive ? '<span class="live" aria-hidden="true"></span>' : ''}`
    + `<h2>${esc(x.title)}</h2>${x.level === 'ok' ? '' : pill(x.level, LEVEL_TEXT[x.level])}${x.meta ? `<span class="meta">${esc(x.meta)}</span>` : ''}</header>${x.body}</section>`;
}

export function classStrip(ctx: Ctx, section: Section | undefined): string {
  if (section && !section.info) return cardHtml(section, true);
  const state = classState(ctx.s.gpus ?? [], ctx.now);
  if (state.open.length) {
    return `<div class="aula on" role="status"><span class="live" aria-hidden="true"></span><div><b>Aula em curso · até ${hhmm(state.endsAt!)}</b>`
      + `<span>${esc(liveFacts(ctx, state).join(' · '))}</span></div></div>`;
  }
  const next = state.next
    ? `Próxima: ${state.next.text}${appName(ctx, state.next.deployment) ? ` · ${appName(ctx, state.next.deployment)}` : ''}. Fora da aula, GPU parada e serviço só na nuvem são o esperado.`
    : 'Nenhuma janela de aula configurada nas GPUs.';
  return `<div class="aula" role="status"><span class="idle" aria-hidden="true"></span><div><b>Sem aula agora</b><span>${esc(next)}</span></div></div>`
    + (section ? cardHtml(section, false) : '');
}
