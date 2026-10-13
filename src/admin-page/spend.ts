import { parisDay, type SpendDay } from '../deployments/spend-ledger';
import { appTitle, count, esc, money, table, type Ctx, type Section } from './ui';

const DAYS_SHOWN = 30;
const COLORS = 6;
const DAY_MS = 86_400_000;
const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const sum = (days: Array<Record<string, SpendDay>>, app: string, field: keyof SpendDay) => days.reduce((a, d) => a + (d[app]?.[field] ?? 0), 0);

export function spendWindow(ctx: Ctx): Array<{ day: string; apps: Record<string, SpendDay> }> {
  const byDay = new Map((ctx.s.spend?.days ?? []).map(d => [d.day, d.apps]));
  return Array.from({ length: DAYS_SHOWN }, (_, i) => {
    const day = parisDay(ctx.now - (DAYS_SHOWN - 1 - i) * DAY_MS);
    return { day, apps: byDay.get(day) ?? {} };
  });
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

export function spend(ctx: Ctx): Section {
  const base = { id: 'gastos', title: 'Gastos por dia', actions: '', count: null };
  const ledger = ctx.s.spend;
  if (!ledger) return { ...base, level: 'ok', note: '', meta: '', body: '<p class="empty">O registro diário de gastos está desligado neste gateway.</p>' };
  const days = spendWindow(ctx);
  const ids = [...new Set(days.flatMap(d => Object.keys(d.apps)))]
    .sort((a, b) => sum(days.map(d => d.apps), b, 'gpuEur') - sum(days.map(d => d.apps), a, 'gpuEur') || a.localeCompare(b));
  const names = new Map(ids.map(id => [id, appTitle(id, ctx.s.apps.find(a => a.id === id)?.profile).name]));
  const last = (n: number) => days.slice(-n).map(d => d.apps);
  const rows = ids.map((id, c) => {
    const today = last(1)[0]![id];
    return [
      `<b><i class="sw c${c % COLORS}"></i>${esc(names.get(id))}</b>${names.get(id) !== id ? `<small class="mono">${esc(id)}</small>` : ''}`,
      `${money(today?.gpuEur ?? 0)}<small>${count(today?.requests ?? 0)} pedidos</small>`,
      `${money(sum(last(7), id, 'gpuEur'))}<small>${count(sum(last(7), id, 'requests'))} pedidos</small>`,
      `${money(sum(last(30), id, 'gpuEur'))}<small>${count(sum(last(30), id, 'requests'))} pedidos</small>`,
      `${count(sum(last(30), id, 'tokens'))}<small>tokens em 30 d</small>`,
    ];
  });
  const total = (n: number) => ids.reduce((a, id) => a + sum(last(n), id, 'gpuEur'), 0);
  const since = ledger.since ? `registro desde ${shortDay(ledger.since)}` : 'registro começa no próximo minuto';
  return {
    ...base, level: 'ok', badge: `<span class="pill info">${money(total(30))} em 30 dias</span>`,
    note: '',
    meta: `GPU hoje ${money(total(1))} · 7 d ${money(total(7))} · 30 d ${money(total(30))} · ${since}`,
    body: chart(days, ids, names)
      + table([{ label: 'App' }, { label: 'Hoje', num: true }, { label: '7 dias', num: true }, { label: '30 dias', num: true }, { label: 'Tokens', num: true }], rows,
        'Nenhum gasto registrado ainda.')
      + '<p class="foot-note">GPU em €: tempo ligado de cada réplica × preço/h, atribuído ao app dono do deployment. Nuvem (OpenRouter): o gateway não recebe o custo por pedido, '
      + 'então contamos pedidos e tokens por app, sem valor em US$. Dias antes do registro ficam vazios.</p>',
  };
}
