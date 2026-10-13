import type { Incident } from '../telemetry/incidents';
import { alertLevel, alertTitle } from '../telemetry/alert-email';
import { ago, count, duration, esc, hhmm, mark, pill, table, when, worst, type Ctx, type Level, type Section } from './ui';

const ACTION_TEXT: Record<string, string> = { park: 'estacionou', retry: 'nova tentativa de boot em', reorder: 'reordenou a reserva de' };
const RESOLUTION_TEXT: Record<string, string> = { cleared: 'a condição normalizou', quiet: 'nenhum alerta novo' };
const SHOWN = 30;

const levelOf = (i: Incident): Level => (i.endedAt ? 'ok' : alertLevel(i.event) === 'urgent' ? 'bad' : 'warn');
const titleOf = (i: Incident) => {
  const t = alertTitle(i.event);
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const targetOf = (i: Incident) => i.key.split(',').map(k => (k.startsWith(`${i.event}|`) ? k.slice(i.event.length + 1) : k)).join(', ');
const actionText = (a: Incident['actions'][number]) => `${ACTION_TEXT[a.kind] ?? a.kind} ${a.target}`;
const lasted = (i: Incident, now: number) => duration((Date.parse(i.endedAt ?? new Date(now).toISOString()) - Date.parse(i.startedAt)) / 1000);

function alertsCell(i: Incident): string {
  return `${count(i.alertCount)}<details><summary>ver</summary><small>${i.alerts.map(a => `${hhmm(a.at)} · ${esc(a.summary)}`).join('<br>')}</small></details>`;
}

function actionsCell(i: Incident): string {
  if (!i.actions.length) return '—';
  return i.actions.map(a => `${esc(actionText(a))}<small>${hhmm(a.at)}${a.detail ? ` · ${esc(a.detail)}` : ''}</small>`).join('');
}

export function incidentsSection(ctx: Ctx): Section {
  const list = ctx.s.incidents ?? [];
  const open = list.filter(i => !i.endedAt);
  const rows = [...open, ...list.filter(i => i.endedAt)].slice(0, SHOWN).map(i => [
    when(i.startedAt, ctx.now),
    `${pill(levelOf(i), i.endedAt ? 'resolvido' : 'aberto')} <b>${esc(titleOf(i))}</b>${i.key ? `<small class="mono">${esc(targetOf(i))}</small>` : ''}`,
    `${lasted(i, ctx.now)}${i.endedAt ? '' : '<small>até agora</small>'}`,
    alertsCell(i),
    actionsCell(i),
    i.endedAt ? `${esc(RESOLUTION_TEXT[i.resolution ?? ''] ?? '—')}<small>às ${hhmm(i.endedAt)}</small>` : '—',
  ]);
  return {
    id: 'incidentes', title: 'Incidentes', level: worst(open.map(levelOf)), count: open.length || null, actions: '', info: true,
    notes: open.map(i => `${titleOf(i)} aberto há ${ago(i.startedAt, ctx.now).replace('há ', '')}`),
    meta: 'alertas da mesma causa e alvo; fecha quando a condição normaliza ou quando os alertas param',
    body: table([{ label: 'Início' }, { label: 'Incidente' }, { label: 'Duração', num: true }, { label: 'Alertas', num: true }, { label: 'Ações' }, { label: 'Resolução' }],
      rows, 'Nenhum incidente registrado.'),
  };
}

export function openIncidents(ctx: Ctx): string {
  const open = (ctx.s.incidents ?? []).filter(i => !i.endedAt);
  if (!open.length) return '';
  const query = ctx.app ? `?app=${encodeURIComponent(ctx.app)}` : '';
  const items = open.map((i) => {
    const last = i.actions.at(-1);
    const facts = [`aberto ${ago(i.startedAt, ctx.now)}`, `${count(i.alertCount)} ${i.alertCount === 1 ? 'alerta' : 'alertas'}`, last ? `${actionText(last)} às ${hhmm(last.at)}` : 'nenhuma ação ainda'];
    return `<li>${mark(levelOf(i))}<div><b>${esc(titleOf(i))}</b>${i.key ? ` <span class="mono">${esc(targetOf(i))}</span>` : ''}<small>${esc(facts.join(' · '))}</small></div></li>`;
  }).join('');
  const level = worst(open.map(levelOf));
  return `<section id="abertos"><header class="sh"><h2>Incidentes abertos</h2>${pill(level, String(open.length))}`
    + `<div class="acts"><a class="btn" href="/admin/atividade${query}#incidentes">Linha do tempo</a></div></header><ul class="incs">${items}</ul></section>`;
}
