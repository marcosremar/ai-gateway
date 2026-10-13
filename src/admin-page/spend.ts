import { parisDay, type SpendDay, type StageCloud } from '../deployments/spend-ledger';
import { CLOUD_PRICES_CHECKED } from './model-prices';
import { appTitle, count, esc, money, stageName, table, type Ctx, type Section } from './ui';

const DAYS_SHOWN = 30;
const COLORS = 6;
const DAY_MS = 86_400_000;
const WEEKS_FOR_FORECAST = 4;
const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const sum = (days: Array<Record<string, SpendDay>>, app: string, field: Exclude<keyof SpendDay, 'stages'>) => days.reduce((a, d) => a + (d[app]?.[field] ?? 0), 0);
const STAGES = ['stt', 'chat', 'tts'];
const stageSum = (days: Array<Record<string, SpendDay>>, app: string, field: keyof StageCloud, stages = STAGES) =>
  days.reduce((a, d) => a + stages.reduce((b, st) => b + (d[app]?.stages?.[st]?.[field] ?? 0), 0), 0);

export function spendWindow(ctx: Ctx): Array<{ day: string; apps: Record<string, SpendDay> }> {
  const byDay = new Map((ctx.s.spend?.days ?? []).map(d => [d.day, d.apps]));
  return Array.from({ length: DAYS_SHOWN }, (_, i) => {
    const day = parisDay(ctx.now - (DAYS_SHOWN - 1 - i) * DAY_MS);
    return { day, apps: byDay.get(day) ?? {} };
  });
}

interface Money { gpuEur: number; cloudUsd: number }
export interface MonthForecast { month: string; lastDay: string; sofar: Money; projected: Money; basis: 'weekday' | 'recent' | 'none' }

const zero = (): Money => ({ gpuEur: 0, cloudUsd: 0 });
const totalOf = (apps: Record<string, SpendDay> | undefined): Money => Object.values(apps ?? {})
  .reduce((a, e) => ({ gpuEur: a.gpuEur + e.gpuEur, cloudUsd: a.cloudUsd + (e.cloudUsd ?? 0) }), zero());
const mean = (xs: Money[]): Money | null => (xs.length
  ? { gpuEur: xs.reduce((a, x) => a + x.gpuEur, 0) / xs.length, cloudUsd: xs.reduce((a, x) => a + x.cloudUsd, 0) / xs.length } : null);
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export function monthForecast(ctx: Ctx): MonthForecast | null {
  const ledger = ctx.s.spend;
  if (!ledger?.since) return null;
  const byDay = new Map(ledger.days.map(d => [d.day, d.apps]));
  const today = parisDay(ctx.now);
  const month = today.slice(0, 7);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const days = Array.from({ length: new Date(Date.UTC(y, m, 0)).getUTCDate() }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const known = (day: string) => day >= ledger.since! && day < today;
  const recent = Array.from({ length: WEEKS_FOR_FORECAST * 7 }, (_, i) => shift(today, -1 - i)).filter(known);
  const fallback = mean(recent.map(d => totalOf(byDay.get(d))));
  const estimate = (day: string) => mean(recent.filter(d => weekday(d) === weekday(day)).map(d => totalOf(byDay.get(d)))) ?? fallback ?? zero();
  const sofar = zero();
  const projected = zero();
  for (const day of days) {
    const actual = day <= today && day >= ledger.since ? totalOf(byDay.get(day)) : null;
    if (actual) { sofar.gpuEur += actual.gpuEur; sofar.cloudUsd += actual.cloudUsd; }
    const guess = day < today && actual ? actual : estimate(day);
    projected.gpuEur += day === today && actual ? Math.max(actual.gpuEur, guess.gpuEur) : guess.gpuEur;
    projected.cloudUsd += day === today && actual ? Math.max(actual.cloudUsd, guess.cloudUsd) : guess.cloudUsd;
  }
  const basis = recent.some(d => weekday(d) === weekday(today)) ? 'weekday' : fallback ? 'recent' : 'none';
  return { month, lastDay: days.at(-1)!, sofar, projected, basis };
}

function chart(days: ReturnType<typeof spendWindow>, apps: string[], names: Map<string, string>): string {
  const H = 110;
  const W = 600;
  const slot = W / days.length;
  const totals = days.map(d => apps.reduce((a, app) => a + (d.apps[app]?.gpuEur ?? 0), 0));
  const max = Math.max(...totals, 0.01);
  const bars = days.map((d, i) => {
    let y = H;
    const stack = apps.map((app, c) => {
      const eur = d.apps[app]?.gpuEur ?? 0;
      const h = eur ? Math.max(1, (eur / max) * H) : 0;
      y -= h;
      return h ? `<rect class="c${c % COLORS}" x="${(i * slot + 2).toFixed(1)}" y="${y.toFixed(1)}" width="${(slot - 4).toFixed(1)}" height="${h.toFixed(1)}"/>` : '';
    }).join('');
    const parts = apps.filter(app => d.apps[app]).map(app => `${names.get(app)} ${money(d.apps[app]!.gpuEur)} · ${count(d.apps[app]!.requests)} pedidos`);
    const label = `${shortDay(d.day)}: total GPU ${money(totals[i])}${parts.length ? ` — ${parts.join('; ')}` : ' — sem registro'}`;
    return `<g><title>${esc(label)}</title><rect class="hit" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}"/>${stack}</g>`;
  }).join('');
  const ticks = days.map((d, i) => `<span>${i % 5 === 4 || i === days.length - 1 ? shortDay(d.day) : ''}</span>`).join('');
  const legend = apps.map((app, c) => `<span><i class="c${c % COLORS}"></i>${esc(names.get(app))}</span>`).join('');
  const peak = days[totals.indexOf(Math.max(...totals))]!;
  return `<div class="chart spend"><div class="cmax">pico ${money(Math.max(...totals))} em ${shortDay(peak.day)}</div>`
    + `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`Gasto de GPU por dia e por app nos últimos ${days.length} dias; pico de ${money(Math.max(...totals))}`)}">`
    + `<line class="gl" x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}"/>${bars}</svg><div class="ticks d30">${ticks}</div>`
    + `<div class="legend">${legend}<span>€ de GPU · dia de Paris</span></div></div>`;
}

const BASIS_TEXT = { weekday: 'pela média do mesmo dia da semana nas últimas 4 semanas', recent: 'pela média dos últimos dias', none: 'sem histórico: só o que já foi gasto' };

function forecastStats(f: MonthForecast): string {
  const cell = (label: string, v: Money) => `<div><span>${esc(label)}</span><b>${money(v.gpuEur)}</b><small>GPU · nuvem ${money(v.cloudUsd, 'US$')}</small></div>`;
  return `<div class="stats">${cell('Mês até agora', f.sofar)}${cell(`Projeção até ${shortDay(f.lastDay)}`, f.projected)}`
    + `<div><span>Como projetamos</span><small>${esc(BASIS_TEXT[f.basis])}</small></div></div>`;
}

const cloudOf = (days: Array<Record<string, SpendDay>>, app: string) => sum(days, app, 'cloudUsd');

function stageTable(days: Array<Record<string, SpendDay>>, ids: string[], names: Map<string, string>): string {
  const usd = (v: number, label = '') => (v ? `${money(v, 'US$')}${label ? `<small>${label}</small>` : ''}` : '—');
  const rows = ids.flatMap(id => STAGES.map(stage => [stage, stageSum(days, id, 'usd', [stage]), stageSum(days, id, 'estimatedUsd', [stage]), stageSum(days, id, 'unknown', [stage])] as const)
    .filter(([, real, estimated, unknown]) => real || estimated || unknown)
    .map(([stage, real, estimated, unknown]) => [`<b>${esc(names.get(id))}</b>`, esc(stageName(stage)), usd(real), usd(estimated, 'estimado'),
      unknown ? `${count(unknown)}<small>custo desconhecido</small>` : '—']));
  return rows.length ? '<h3 class="sub">Nuvem por etapa · 30 dias</h3>'
    + table([{ label: 'App' }, { label: 'Etapa' }, { label: 'Informado', num: true }, { label: 'Estimado', num: true }, { label: 'Chamadas sem preço', num: true }], rows, '') : '';
}

export function spend(ctx: Ctx): Section {
  const base = { id: 'gastos', title: 'Gasto por dia', actions: '', count: null };
  const ledger = ctx.s.spend;
  if (!ledger) return { ...base, level: 'ok', notes: [], meta: '', body: '<p class="empty">O registro diário de gastos está desligado neste gateway.</p>' };
  const days = spendWindow(ctx);
  const ids = [...new Set(days.flatMap(d => Object.keys(d.apps)))]
    .sort((a, b) => sum(days.map(d => d.apps), b, 'gpuEur') - sum(days.map(d => d.apps), a, 'gpuEur') || a.localeCompare(b));
  const names = new Map(ids.map(id => [id, appTitle(id, ctx.s.apps.find(a => a.id === id)?.profile).name]));
  const last = (n: number) => days.slice(-n).map(d => d.apps);
  const cell = (id: string, n: number) => {
    const cloud = cloudOf(last(n), id);
    const estimated = stageSum(last(n), id, 'estimatedUsd');
    const unknown = stageSum(last(n), id, 'unknown');
    return `${money(sum(last(n), id, 'gpuEur'))}<small>${cloud ? `nuvem ${money(cloud, 'US$')} · ` : ''}${count(sum(last(n), id, 'requests'))} pedidos</small>`
      + (estimated ? `<small>${money(estimated, 'US$')} estimado</small>` : '') + (unknown ? `<small>${count(unknown)} com custo desconhecido</small>` : '');
  };
  const rows = ids.map((id, c) => [
    `<b><i class="sw c${c % COLORS}"></i>${esc(names.get(id))}</b>${names.get(id) !== id ? `<small class="mono">${esc(id)}</small>` : ''}`,
    cell(id, 1), cell(id, 7), cell(id, 30),
    `${count(sum(last(30), id, 'tokens'))}<small>tokens em 30 d</small>`,
  ]);
  const total = (n: number) => ids.reduce((a, id) => a + sum(last(n), id, 'gpuEur'), 0);
  const cloudTotal = ids.reduce((a, id) => a + cloudOf(last(30), id), 0);
  const since = ledger.since ? `registro desde ${shortDay(ledger.since)}` : 'registro começa no próximo minuto';
  const forecast = monthForecast(ctx);
  return {
    ...base, level: 'ok', badge: `<span class="pill info">${money(total(30))} em 30 dias</span>`,
    notes: [],
    meta: `GPU hoje ${money(total(1))} · 7 d ${money(total(7))} · 30 d ${money(total(30))} · nuvem 30 d ${money(cloudTotal, 'US$')} · ${since}`,
    body: (forecast ? forecastStats(forecast) : '') + chart(days, ids, names)
      + table([{ label: 'App' }, { label: 'Hoje', num: true }, { label: '7 dias', num: true }, { label: '30 dias', num: true }, { label: 'Tokens', num: true }], rows,
        'Nenhum gasto registrado ainda.')
      + stageTable(last(30), ids, names)
      + '<p class="foot-note">GPU em €: tempo ligado de cada réplica × preço/h, atribuído ao app dono do deployment. Nuvem em US$, atribuída ao app da chave: '
      + 'o custo que a OpenRouter informa (usage.cost da conversa e da fala → texto, custo da geração do texto → fala); sem ele, estimado pelo preço público '
      + `(lista da OpenRouter; Groq e OpenAI conferidos em ${shortDay(CLOUD_PRICES_CHECKED)}) × segundos de áudio ou caracteres. Sem preço conhecido: custo desconhecido, nunca zero. `
      + 'Dias antes do registro ficam vazios.</p>',
  };
}
