import type { DeploymentView, WarmScheduleEntry } from '../deployments/types';
import { hhmm as minutesOf } from '../deployments/autoscale';
import type { Recommendation } from './recommendations';
import { SLOT_MIN, type DayUse, type TrafficLine } from './traffic';
import { appTitle, count, money, ms, pct, stageName, upOf, type Ctx } from './ui';

const WEEKS_PER_MONTH = 4.35;
const MIN_DAYS = 3;
const MIN_GAP_MIN = 20;
const MARGIN_MIN = 5;
const DEFAULT_BOOT_MIN = 10;
const FLAKY_SHARE = 0.2;
const STEADY_SHARE = 0.05;
const MIN_ATTEMPTS = 20;
const FASTER = 0.7;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.round(minutes % 60)).padStart(2, '0')}`;
const roundDown5 = (m: number) => Math.floor(m / 5) * 5;
const roundUp5 = (m: number) => Math.ceil(m / 5) * 5;
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

function priceOf(d: DeploymentView): number {
  const live = upOf(d).reduce((a, r) => a + (r.pricePerHour ?? 0), 0);
  return live || d.spec.maxEurPerHour || 0;
}

function windowDays(w: WarmScheduleEntry, use: DayUse[], since: string): Array<{ first: number; last: number }> {
  const from = Math.max(0, Math.floor((minutesOf(w.start) - 60) / SLOT_MIN));
  const to = Math.min(1440 / SLOT_MIN - 1, Math.floor((minutesOf(w.end) + 60) / SLOT_MIN));
  return use.filter(u => u.day >= since && (!w.days?.length || w.days.includes(weekday(u.day)))).flatMap((u) => {
    const active = u.slots.map((n, i) => (n && i >= from && i <= to ? i : -1)).filter(i => i >= 0);
    return active.length ? [{ first: active[0]! * SLOT_MIN, last: active.at(-1)! * SLOT_MIN + SLOT_MIN }] : [];
  });
}

export function warmWindowRules(ctx: Ctx): Recommendation[] {
  const { s, now } = ctx;
  const out: Recommendation[] = [];
  const since = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10);
  for (const d of s.gpus ?? []) {
    const app = d.app ?? s.apps.find(a => a.profile?.gpuDeployments.includes(d.name))?.id;
    const use = app ? s.traffic?.daily?.[app] : undefined;
    const price = priceOf(d);
    if (!app || !use || !d.spec.warmSchedule?.length) continue;
    const bootMin = Math.ceil((d.boot?.expectedBootSeconds ?? DEFAULT_BOOT_MIN * 60) / 60);
    const name = appTitle(app, s.apps.find(a => a.id === app)?.profile).name;
    for (const w of d.spec.warmSchedule) {
      const days = windowDays(w, use, since);
      if (days.length < MIN_DAYS) continue;
      const start = minutesOf(w.start);
      const end = minutesOf(w.end);
      const first = median(days.map(u => u.first));
      const last = median(days.map(u => u.last));
      const perMonth = (minutes: number) => (minutes / 60) * price * (w.days?.length || 7) * WEEKS_PER_MONTH;
      const seen = `${days.length} dias de aula em 14 · primeiro pedido típico ${clock(first)} · último ${clock(last)} · boot típico ${bootMin} min · janela ${w.start}–${w.end}`;
      const late = start + bootMin - first;
      if (late > 0) {
        const at = roundDown5(first - bootMin - MARGIN_MIN);
        out.push({
          id: `warm-late:${d.name}:${w.start}`, level: 'warn', title: `${d.name} fica pronta depois dos primeiros pedidos de ${name}`,
          saw: seen, why: `Com o aquecimento às ${w.start} e ~${bootMin} min de boot, os primeiros ~${Math.round(late)} min da aula vão para a reserva na nuvem.`,
          impact: null, gain: `GPU pronta antes do primeiro pedido (hoje ~${Math.round(late)} min na nuvem por aula)`,
          action: { text: `PATCH /v1/deployments/${d.name} warmSchedule: início ${clock(at)} em vez de ${w.start}` },
        });
      } else if (-late >= MIN_GAP_MIN && price) {
        const at = roundDown5(first - bootMin - MARGIN_MIN);
        const saved = perMonth(at - start);
        if (at > start) {
          out.push({
            id: `warm-early:${d.name}:${w.start}`, level: 'ok', title: `${d.name} aquece ${Math.round(at - start)} min antes do necessário`,
            saw: seen, why: `O primeiro pedido chega por volta de ${clock(first)}; ligar às ${clock(at)} ainda deixa a GPU pronta ${MARGIN_MIN} min antes.`,
            impact: { amount: saved, unit: '€', text: `~${money(saved)}/mês` }, saving: { perMonth: saved, unit: '€' },
            action: { text: `PATCH /v1/deployments/${d.name} warmSchedule: início ${clock(at)} em vez de ${w.start}` },
          });
        }
      }
      const until = roundUp5(last + MARGIN_MIN * 2);
      if (end - until >= MIN_GAP_MIN && price) {
        const saved = perMonth(end - until);
        out.push({
          id: `warm-end:${d.name}:${w.end}`, level: 'ok', title: `${d.name} fica aquecida ${Math.round(end - until)} min depois do último pedido`,
          saw: seen, why: `O último pedido chega por volta de ${clock(last)}; a janela vai até ${w.end} e a réplica ainda espera ${d.spec.idleMinutes ?? 0} min sem uso depois dela.`,
          impact: { amount: saved, unit: '€', text: `~${money(saved)}/mês` }, saving: { perMonth: saved, unit: '€' },
          action: { text: `PATCH /v1/deployments/${d.name} warmSchedule: fim ${clock(until)} em vez de ${w.end}` },
        });
      }
    }
  }
  return out;
}

const attempts = (l: TrafficLine) => l.served + l.fallbacks;
const flaky = (l: TrafficLine) => l.fallbacks / attempts(l);

export function linkReorderRules(ctx: Ctx): Recommendation[] {
  const { s } = ctx;
  const out: Recommendation[] = [];
  for (const [stage, byAlias] of Object.entries(s.chains ?? {})) {
    for (const [alias, chain] of Object.entries(byAlias)) {
      const app = s.apps.find(a => a.stages?.[stage]?.includes(alias))?.id;
      const links = s.traffic?.byApp?.[app ?? '']?.links ?? s.traffic?.links ?? [];
      const cloud = chain.links.map(l => l.target).filter(t => !t.startsWith('deployment:'))
        .map(target => ({ target, line: links.find(l => l.key === `${stage}|${target}`) }))
        .filter((x): x is { target: string; line: TrafficLine } => Boolean(x.line && attempts(x.line) >= MIN_ATTEMPTS));
      for (let i = 0; i < cloud.length; i++) {
        const a = cloud[i]!;
        const b = cloud.slice(i + 1).find(x => flaky(x.line) <= STEADY_SHARE
          && (flaky(a.line) >= FLAKY_SHARE || (a.line.p95Ms !== null && x.line.p95Ms !== null && x.line.p95Ms <= a.line.p95Ms * FASTER)));
        if (!b) continue;
        const slow = flaky(a.line) < FLAKY_SHARE;
        out.push({
          id: `link-reorder:${stage}:${alias}`, level: 'warn', title: `${stageName(stage)} ${alias}: ${b.target} responde melhor que ${a.target}`,
          saw: `${a.target}: ${pct(flaky(a.line))} de falhas em ${count(attempts(a.line))} tentativas, p95 ${ms(a.line.p95Ms)} · `
            + `${b.target}: ${pct(flaky(b.line))} de falhas, p95 ${ms(b.line.p95Ms)} (24 h)`,
          why: slow ? 'O primeiro link da reserva é bem mais lento que o seguinte; cada turno espera por ele antes do hedge.'
            : 'O primeiro link da reserva falha com frequência; cada falha custa uma tentativa e o tempo dela antes do link seguinte.',
          impact: null,
          gain: slow ? `p95 ${ms(a.line.p95Ms)} → ${ms(b.line.p95Ms)}` : `~${count(a.line.fallbacks)} desvios a menos por dia`,
          action: { text: `PUT /v1/apps/${app ?? '<app>'}/routes: em ${alias}, ${b.target} antes de ${a.target} (mesmo modelo/voz? confira antes)` },
        });
        break;
      }
    }
  }
  return out;
}
