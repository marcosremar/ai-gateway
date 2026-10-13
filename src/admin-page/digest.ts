import type { AlertMail } from '../telemetry/alert-email';
import { readStateFile, writeStateFile } from '../deployments/state-file';
import { localClock } from '../deployments/autoscale';
import { parisDay } from '../deployments/spend-ledger';
import { eurPerHourNow, eurPerMonth, pageOf, possibleSaving, type Recommendation } from './recommendations';
import { esc, form, money, shortDate, type Ctx } from './ui';

export const DIGEST_WEEKDAY = 1;
export const DIGEST_HOUR = 8;
export const DIGEST_URGENT_EUR_MONTH = 10;
export const DIGEST_TICK_MS = 5 * 60_000;
export const DIGEST_BOOT_QUIET_MS = 15 * 60_000;
export const DIGEST_IMMEDIATE_GAP_MS = 60 * 60_000;
export const DIGEST_FORGET_MS = 30 * 86_400_000;
export type DigestKind = 'weekly' | 'immediate' | 'manual';
export const DIGEST_KIND: Record<string, string> = { weekly: 'semanal', immediate: 'sugestão nova de alto impacto', manual: 'enviado pelo painel' };
const ALERTED_ELSEWHERE = ['reserve-failed:', 'balance-low:', 'gpu-idle:', 'gpu-outside:', 'overspend:'];

export interface DigestStatus { enabled: boolean; lastSentAt: string | null; lastKind: DigestKind | null }
interface DigestState { lastSentAt: string | null; lastKind: DigestKind | null; weeklyDay: string | null; immediateAt: number | null; sent: Record<string, number> }

export const highImpact = (r: Recommendation) => eurPerMonth(r) >= DIGEST_URGENT_EUR_MONTH || (r.level === 'bad' && !ALERTED_ELSEWHERE.some(p => r.id.startsWith(p)));

export const rankForDigest = (list: Recommendation[]) => [...list].sort((a, b) => Number(highImpact(b)) - Number(highImpact(a)));

function effect(r: Recommendation): string {
  const parts = [
    r.saving ? `Economiza ~${money(r.saving.perMonth, r.saving.unit)}/mês` : r.impact ? `Custo: ${r.impact.text}` : '',
    r.gain ? `Melhora: ${r.gain}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : r.level === 'bad' ? 'Risco ao serviço' : r.level === 'warn' ? 'Pede atenção' : 'Arrumação';
}

function actionText(r: Recommendation): string {
  if ('park' in r.action) return `estacionar ${r.action.park} (botão no painel)`;
  if ('probe' in r.action) return 'testar as reservas (botão no painel)';
  if ('go' in r.action) return r.action.label;
  return r.action.text;
}

export function digestMail(list: Recommendation[], opts: { now: number; baseUrl: string; sent: Record<string, number>; kind: DigestKind }): AlertMail {
  const ranked = rankForDigest(list);
  const fresh = new Set(ranked.filter(r => !(r.id in opts.sent)).map(r => r.id));
  const total = possibleSaving(ranked, opts.now);
  const first = ranked.find(r => fresh.has(r.id) && highImpact(r));
  const subject = opts.kind === 'immediate' && first ? `nova sugestão: ${first.title}`
    : `resumo das sugestões: ${ranked.length} ${ranked.length === 1 ? 'aberta' : 'abertas'}${total.restOfMonthEur ? `, economia possível ${money(total.restOfMonthEur)} este mês` : ''}`;
  const items = ranked.map((r, i) => [
    `${i + 1}. ${fresh.has(r.id) ? '[NOVA] ' : ''}${r.title}`,
    `   ${effect(r)}`,
    `   O que fazer: ${actionText(r)}`,
    `   Ver: ${opts.baseUrl}${pageOf(r)}`,
  ].join('\n'));
  const head = [
    `Sugestões abertas do ai-gateway em ${shortDate(opts.now)} (Paris), da mais importante para a menos.`,
    total.monthEur || total.nowEurPerHour
      ? `Economia possível este mês: ${money(total.restOfMonthEur)} (${money(total.monthEur)} por mês cheio)${total.nowEurPerHour ? `, mais ${money(total.nowEurPerHour)}/h em GPU ligada sem uso agora` : ''}.`
      : '',
    fresh.size ? `${fresh.size} ${fresh.size === 1 ? 'nova' : 'novas'} desde o último resumo, marcadas [NOVA].` : '',
  ].filter(Boolean).join('\n');
  const body = `${head}\n\n${items.length ? items.join('\n\n') : 'Nenhuma sugestão aberta: nada a fazer agora.'}\n\n`
    + `Painel: ${opts.baseUrl}/admin · ocultar uma sugestão por 7 dias: botão «Ocultar 7 dias» no painel.`;
  return { kind: `digest|${opts.kind}`, level: 'warn', subject, body };
}

export function createSuggestionDigest(opts: {
  list: () => Recommendation[];
  deliver: ((mail: AlertMail) => Promise<string | null>) | null;
  classOpen: () => boolean;
  baseUrl: string;
  path?: string;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}) {
  const now = opts.now ?? Date.now;
  const bootedAt = now();
  let state: DigestState = { lastSentAt: null, lastKind: null, weeklyDay: null, immediateAt: null, sent: {} };
  let timer: ReturnType<typeof setInterval> | null = null;
  let sending: Promise<string | null> | null = null;

  async function save(): Promise<void> {
    if (opts.path) await writeStateFile(opts.path, JSON.stringify(state)).catch(err => opts.log?.('digest: state write failed', { error: String(err) }));
  }

  async function send(kind: DigestKind, list: Recommendation[]): Promise<string | null> {
    if (!opts.deliver) return null;
    const t = now();
    const id = await opts.deliver(digestMail(list, { now: t, baseUrl: opts.baseUrl, sent: state.sent, kind }));
    if (!id) return null;
    const open = new Set(list.map(r => r.id));
    for (const r of list) state.sent[r.id] ??= t;
    for (const [rid, at] of Object.entries(state.sent)) if (!open.has(rid) && t - at > DIGEST_FORGET_MS) delete state.sent[rid];
    state = { ...state, lastSentAt: new Date(t).toISOString(), lastKind: kind, ...(kind === 'weekly' ? { weeklyDay: parisDay(t) } : {}), ...(kind === 'immediate' ? { immediateAt: t } : {}) };
    await save();
    opts.log?.('digest: sent', { kind, suggestions: list.length });
    return id;
  }

  const once = (run: () => Promise<string | null>) => (sending ??= run().finally(() => { sending = null; }));

  function weeklyDue(t: number): boolean {
    const clock = localClock(t, 'Europe/Paris');
    return clock.day === DIGEST_WEEKDAY && clock.minutes >= DIGEST_HOUR * 60 && state.weeklyDay !== parisDay(t) && !opts.classOpen();
  }

  async function tick(): Promise<string | null> {
    const t = now();
    if (!opts.deliver || t - bootedAt < DIGEST_BOOT_QUIET_MS || sending) return null;
    const list = opts.list();
    if (weeklyDue(t)) {
      if (list.length) return once(() => send('weekly', list));
      state.weeklyDay = parisDay(t);
      await save();
      return null;
    }
    const fresh = list.filter(r => highImpact(r) && !(r.id in state.sent));
    if (!fresh.length || t - (state.immediateAt ?? -Infinity) < DIGEST_IMMEDIATE_GAP_MS) return null;
    return once(() => send('immediate', list));
  }

  return {
    async load(): Promise<void> {
      if (!opts.path) return;
      const read = await readStateFile<DigestState>(opts.path);
      if (read.data) state = { ...state, ...read.data, sent: read.data.sent ?? {} };
    },
    tick,
    sendNow: () => once(() => send('manual', opts.list())),
    status: (): DigestStatus => ({ enabled: Boolean(opts.deliver), lastSentAt: state.lastSentAt, lastKind: state.lastKind }),
    start(intervalMs = DIGEST_TICK_MS): void {
      if (timer || !opts.deliver) return;
      timer = setInterval(() => { void tick().catch(err => opts.log?.('digest: tick failed', { error: String(err) })); }, intervalMs);
      timer.unref?.();
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
  };
}

export function digestBlock(ctx: Ctx): { actions: string; body: string } {
  const d = ctx.s.digest;
  if (!d || ctx.view) return { actions: '', body: '' };
  const last = d.lastSentAt ? `Último resumo enviado em ${shortDate(d.lastSentAt)} (${DIGEST_KIND[d.lastKind ?? ''] ?? 'resumo'})` : 'Nenhum resumo enviado ainda';
  const when = d.enabled ? 'por e-mail às segundas, 8h de Paris, e na hora quando surge uma sugestão de alto impacto'
    : 'e-mail desligado: configure ALERT_EMAIL_TO e RESEND_API_KEY';
  return {
    actions: d.enabled ? form('/admin/digest', ctx.csrf, 'Enviar resumo agora', 'Enviar agora por e-mail o resumo das sugestões abertas?', {}, 'quiet', ctx.path) : '',
    body: `<p class="digest">${esc(last)} · ${esc(when)}</p>`,
  };
}
