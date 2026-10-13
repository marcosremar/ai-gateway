import type { AppProfile } from '../deployments/apps';
import type { DeploymentView } from '../deployments/types';
import { activeWindow, DEFAULT_WARM_TIME_ZONE, localClock } from '../deployments/autoscale';
import type { AdminSnapshot, AppView } from './render';
import { FALLBACK_PROBE_CALLER } from '../telemetry/fallback-probe';

export type Level = 'ok' | 'warn' | 'bad';

export interface Section { id: string; title: string; level: Level; notes: string[]; count: number | null; meta: string; actions: string; body: string; badge?: string; info?: boolean }

export interface Ctx { s: AdminSnapshot; now: number; csrf: string; app: string | null; view: AppView | null; path?: string }

export const ALERT_FRESH_MS = 60 * 60_000;
export const NEAR_LIMIT = 0.8;
export const ZONE = 'Europe/Paris';
export const ACTIVITY_SHOWN = 30;

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export const worst = (levels: Level[]): Level => (levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok');
export const RANK: Record<Level, number> = { bad: 0, warn: 1, ok: 2 };
export const byLevel = <T extends { level: Level }>(a: T, b: T) => RANK[a.level] - RANK[b.level];
export const ratioLevel = (used: number, limit: number | null | undefined): Level => {
  if (!limit || limit <= 0) return 'ok';
  return used >= limit ? 'bad' : used >= limit * NEAR_LIMIT ? 'warn' : 'ok';
};
export const CURRENCY: Record<string, Intl.NumberFormat> = {};
export const money = (v: number | null | undefined, unit = '€') => {
  if (v === null || v === undefined) return '—';
  const code = unit === '€' ? 'EUR' : 'USD';
  CURRENCY[code] ??= new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code });
  return CURRENCY[code].format(v);
};
export const count = (v: number) => new Intl.NumberFormat('pt-BR', { notation: v >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(v);
export const pct = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 }).format(v);
export const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2).replace('.', ',')} s` : `${count(Math.round(v))} ms`);
export const latest = (dates: Array<string | null | undefined>) => dates.filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;
export const hhmm = (iso: string | number) => new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(typeof iso === 'number' ? iso : Date.parse(iso));
export const shortDate = (at: string | number) => new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  .format(typeof at === 'number' ? at : Date.parse(at)).replace(',', ' às');
export const hour = (iso: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit' }).format(Date.parse(iso));

export const ago = (iso: string | null, now: number) => {
  if (!iso) return 'nunca';
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  return min < 1 ? 'agora' : min < 120 ? `há ${min} min` : min < 2880 ? `há ${Math.round(min / 60)} h` : `há ${Math.round(min / 1440)} d`;
};
export const when = (iso: string | null, now: number) => (iso ? `${hhmm(iso)}<small>${esc(ago(iso, now))}</small>` : 'nunca');
export const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
export const duration = (seconds: number) => (seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1).replace('.', ',')} h`);

export const LEVEL_TEXT: Record<Level, string> = { ok: 'Normal', warn: 'Atenção', bad: 'Problema' };
export const GLYPH: Record<Level, string> = {
  ok: '<circle class="s" cx="10" cy="10" r="9"/><path class="g" d="m6 10.3 2.7 2.7L14 7.5"/>',
  warn: '<path class="s" d="M10 1.6 19.2 18H.8z"/><path class="g" d="M10 7.5v4.6m0 2.7v.1"/>',
  bad: '<path class="s" d="M6.3 1h7.4L19 6.3v7.4L13.7 19H6.3L1 13.7V6.3z"/><path class="g" d="m7 7 6 6m0-6-6 6"/>',
};
export const mark = (level: Level) => `<span class="mark ${level}"><svg viewBox="0 0 20 20" aria-hidden="true">${GLYPH[level]}</svg><span class="sr">${LEVEL_TEXT[level]}:</span></span>`;
export const pill = (level: Level, text: string) => `<span class="pill ${level}">${mark(level)}${esc(text)}</span>`;
export const meter = (used: number, limit: number | null | undefined, level: Level) => (limit && limit > 0
  ? `<svg class="use ${level}" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="t" width="100" height="4"/><rect class="f" width="${Math.min(100, Math.round((used / limit) * 100))}" height="4"/></svg>`
  : '');
export const form = (action: string, csrf: string, label: string, confirmText: string, fields: Record<string, string> = {}, cls = '', back = '') =>
  `<form method="post" action="${action}"${confirmText ? ` data-confirm="${esc(confirmText)}"` : ''}><input type="hidden" name="csrf" value="${csrf}">${
    back ? `<input type="hidden" name="back" value="${esc(back)}">` : ''}${
    Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')
  }<button${cls ? ` class="${cls}"` : ''}>${esc(label)}</button></form>`;

export interface Col { label: string; num?: boolean; act?: boolean; wide?: boolean }

export function table(cols: Col[], rows: string[][], empty: string): string {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  const cls = (c: Col) => {
    const names = [c.num ? 'n' : c.act ? 'act' : '', c.wide ? 'wide' : ''].filter(Boolean).join(' ');
    return names ? ` class="${names}"` : '';
  };
  const head = cols.map(c => `<th${cls(c)}>${c.act ? `<span class="sr">${esc(c.label)}</span>` : esc(c.label)}</th>`).join('');
  const body = rows.map(r => `<tr>${r.map((cell, i) => `<td${cls(cols[i]!)} data-l="${esc(cols[i]!.label)}"><div class="v">${cell}</div></td>`).join('')}</tr>`).join('');
  return `<div class="tw"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export const STAGE: Record<string, string> = { stt: 'Fala → texto', chat: 'Conversa', llm: 'Conversa', tts: 'Texto → fala', s2s: 'Fala → fala', translate: 'Tradução' };
export const stageName = (stage: string) => STAGE[stage] ?? stage;

export const KNOWN_APPS: Record<string, { name: string; description: string }> = {
  parle: { name: 'Parle', description: 'Jogo de português: o aluno conversa por voz com os personagens (fala → texto, conversa, texto → fala).' },
  babelcast: { name: 'Babelcast', description: 'Tradução simultânea: transcreve a fala ao vivo e a traduz em texto e voz.' },
  [FALLBACK_PROBE_CALLER]: { name: 'Teste das reservas', description: 'O pedido mínimo que o gateway faz a cada reserva na nuvem a cada 15 min.' },
};

export const appTitle = (id: string, profile: AppProfile | null | undefined) => ({
  name: profile?.name || KNOWN_APPS[id]?.name || id, description: profile?.description || KNOWN_APPS[id]?.description || null,
});

export const upOf = (d: DeploymentView) => d.replicas.filter(r => r.phase !== 'halted');
export const outsideWindow = (d: DeploymentView, now: number) => Boolean(d.spec.warmSchedule?.length) && upOf(d).length > 0 && !activeWindow(d.spec.warmSchedule, now);

export const providerOf = (d: DeploymentView) => upOf(d)[0]?.provider ?? d.spec.provider;
export const providerLabel = (d: DeploymentView) => (providerOf(d) === 'vast' ? 'Vast · laboratório, barata' : 'Scaleway · produção');
export const pinBadge = (d: DeploymentView) => {
  if (!d.pinned) return '';
  const m = d.pinned.idleMinutes;
  const after = m ? `estaciona após ${m % 60 ? `${m} min` : `${m / 60} h`} sem uso` : 'nunca estaciona sozinha';
  return ` <span class="pill info">fixada</span><small>${esc(d.pinned.parked ? 'estacionada · acorda no próximo pedido' : after)}</small>`;
};

const DAY_MS = 86_400_000;
const WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export interface ClassState { open: DeploymentView[]; endsAt: number | null; next: { at: number; text: string; deployment: DeploymentView } | null }

function nextStart(d: DeploymentView, now: number): number | null {
  let best: number | null = null;
  for (const e of d.spec.warmSchedule ?? []) {
    const zone = e.timeZone ?? DEFAULT_WARM_TIME_ZONE;
    const [h, m] = e.start.split(':').map(Number);
    const offset = (h! * 60 + m! - localClock(now, zone).minutes) * 60_000;
    for (let i = 0; i <= 7; i++) {
      const at = Math.floor((now + i * DAY_MS + offset) / 60_000) * 60_000;
      if (at <= now || (e.days?.length && !e.days.includes(localClock(at, zone).day))) continue;
      if (best === null || at < best) best = at;
      break;
    }
  }
  return best;
}

function dayText(at: number, now: number): string {
  const { day } = localClock(at, ZONE);
  const today = localClock(now, ZONE).day;
  const name = day === today ? 'hoje' : day === (today + 1) % 7 ? 'amanhã' : WEEKDAY[day]!;
  return `${name} às ${hhmm(at)}`;
}

export function classState(gpus: DeploymentView[], now: number): ClassState {
  const open = gpus.map(d => ({ d, w: activeWindow(d.spec.warmSchedule, now) })).filter(x => x.w);
  if (open.length) return { open: open.map(x => x.d), endsAt: Math.max(...open.map(x => x.w!.endsAt)), next: null };
  const next = gpus.map(d => ({ d, at: nextStart(d, now) })).filter(x => x.at !== null).sort((a, b) => a.at! - b.at!)[0];
  return { open: [], endsAt: null, next: next ? { at: next.at!, text: dayText(next.at!, now), deployment: next.d } : null };
}

export const appGpus = (s: AdminSnapshot, app: string) => {
  const names = new Set(s.apps.find(a => a.id === app)?.profile?.gpuDeployments ?? []);
  return (s.gpus ?? []).filter(d => d.app === app || names.has(d.name));
};

export const inClass = (s: AdminSnapshot, app: string, now: number) => appGpus(s, app).some(d => activeWindow(d.spec.warmSchedule, now));
