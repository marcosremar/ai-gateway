import type { ChainReport, LinkReport } from '../config/stage-chains';
import type { DeploymentView } from '../deployments/types';
import type { FallbackProbeResult } from '../telemetry/fallback-probe';
import type { Promotion } from '../gateway/proxy/link-reorder';
import type { AdminApp, AdminSnapshot } from './render';
import { bootHeadline, bootOf, detailHref } from './boot';
import { appTitle, esc, hhmm, inClass, mark, ms, pct, pill, providerLabel, stageName, upOf, worst, type Ctx, type Level, type Section } from './ui';

export type Verdict = 'garantido' | 'so-nuvem' | 'sem-reserva' | 'sem-garantia';

export interface ChainLink {
  target: string;
  kind: 'own-gpu' | 'other-gpu' | 'local' | 'cloud';
  state: string;
  level: Level;
  working: boolean;
  serving: boolean;
  deployment: DeploymentView | null;
  probe: FallbackProbeResult | null;
  p50Ms: number | null;
  share: number | null;
  reorder?: { role: 'promoted' | 'demoted'; reason: string };
}

export interface Service { app: string; stage: string; alias: string; links: ChainLink[]; verdict: Verdict; level: Level }

const VERDICT_TEXT: Record<Verdict, string> = {
  garantido: 'Garantido', 'so-nuvem': 'Só nuvem', 'sem-reserva': 'Sem reserva testada', 'sem-garantia': 'Sem garantia',
};
const BROKEN = new Set(['missing', 'pending', 'disabled', 'no_key', 'blocked', 'circuit_open', 'paused']);

function gpuState(link: LinkReport, d: DeploymentView | null): { state: string; level: Level; working: boolean } {
  if (link.state === 'ready') return { state: 'ligada', level: 'ok', working: true };
  const boot = d && bootOf(d);
  if (boot) return { state: bootHeadline(boot), level: boot.stuck ? 'bad' : 'warn', working: false };
  if (link.state === 'paused') return { state: 'pausada', level: 'warn', working: false };
  if (link.state === 'cold') {
    if (d?.status === 'warming') return { state: 'acordando', level: 'warn', working: false };
    return { state: d?.replicas.some(r => r.phase === 'halted') ? 'estacionada' : 'desligada · liga no pedido', level: 'ok', working: false };
  }
  return { state: link.state === 'circuit_open' || link.state === 'blocked' ? 'falhou' : 'indisponível', level: 'bad', working: false };
}

function cloudState(link: LinkReport, probe: FallbackProbeResult | null): { state: string; level: Level; working: boolean } {
  if (BROKEN.has(link.state)) return { state: 'falhou', level: 'bad', working: false };
  if (!probe) return { state: 'sem teste', level: 'warn', working: true };
  if (!probe.ok) return { state: 'falhou no teste', level: 'bad', working: false };
  return probe.content === 'mismatch' ? { state: 'conteúdo estranho', level: 'warn', working: true } : { state: 'ok', level: 'ok', working: true };
}

const providerOf = (target: string) => (target.startsWith('deployment:') ? target : target.split(':')[0]!);

function verdictOf(links: ChainLink[], app: AdminApp, classOpen: boolean): { verdict: Verdict; level: Level } {
  const gpuOk = links.some(l => l.kind !== 'cloud' && l.working);
  const cloudOk = links.some(l => l.kind === 'cloud' && l.working && l.probe?.ok);
  const anyOk = links.some(l => l.working);
  const hasGpu = links.some(l => l.kind !== 'cloud');
  if (!anyOk) return { verdict: 'sem-garantia', level: 'bad' };
  if (cloudOk && (gpuOk || !hasGpu)) return { verdict: 'garantido', level: 'ok' };
  if (cloudOk) return { verdict: 'so-nuvem', level: app.profile?.requiresGpu && classOpen ? 'warn' : 'ok' };
  return { verdict: 'sem-reserva', level: 'warn' };
}

export function services(s: AdminSnapshot, filter: string | null = null, now = Date.now()): Service[] {
  const out: Service[] = [];
  const gpus = new Map((s.gpus ?? []).map(d => [d.name, d]));
  for (const app of s.apps.filter(a => !filter || a.id === filter)) {
    const classOpen = inClass(s, app.id, now);
    const t = s.traffic?.byApp?.[app.id] ?? (s.traffic?.byApp ? null : s.traffic);
    const stageTotal = new Map((t?.stages ?? []).map(l => [l.key, l.served]));
    const linkTraffic = new Map((t?.links ?? []).map(l => [l.key, l]));
    for (const [stage, aliases] of Object.entries(app.stages ?? {})) {
      for (const alias of aliases) {
        const report: ChainReport | undefined = s.chains?.[stage]?.[alias];
        if (!report) continue;
        const links = report.links.map((link): ChainLink => {
          const name = link.target.startsWith('deployment:') ? link.target.slice('deployment:'.length) : null;
          const d = name ? gpus.get(name) ?? null : null;
          const probes = s.reserves.links.filter(p => p.stage === stage && p.target === link.target);
          const probe = name ? null : probes.find(p => p.aliases.includes(alias)) ?? probes[0] ?? null;
          const live = name ? gpuState(link, d) : cloudState(link, probe);
          const t = linkTraffic.get(`${stage}|${link.target}`) ?? linkTraffic.get(`${stage}|${providerOf(link.target)}`);
          const total = stageTotal.get(stage);
          return {
            target: link.target, kind: link.target.startsWith('local:') ? 'local' : !name ? 'cloud' : d?.app === app.id || app.profile?.gpuDeployments.includes(name) ? 'own-gpu' : 'other-gpu',
            ...live, serving: report.serving === link.target, deployment: d, probe,
            p50Ms: t?.p50Ms ?? null, share: t && total ? t.served / total : null,
          };
        });
        out.push({ app: app.id, stage, alias, links: reordered(links, (s.reorders ?? []).filter(p => p.chainKey === `${stage}|${alias}`)), ...verdictOf(links, app, classOpen) });
      }
    }
  }
  return out;
}

function reordered(links: ChainLink[], promotions: Promotion[]): ChainLink[] {
  const out = [...links];
  for (const p of promotions) {
    const up = out.findIndex(l => l.target === p.leader);
    const down = out.findIndex(l => l.target === p.declared);
    if (up < 0 || down < 0) continue;
    [out[up], out[down]] = [{ ...out[down]!, reorder: { role: 'demoted', reason: p.reason } }, { ...out[up]!, reorder: { role: 'promoted', reason: p.reason } }];
  }
  return out;
}

function linkName(l: ChainLink): string {
  if (l.kind === 'cloud') return `API na nuvem <code>${esc(l.target)}</code>`;
  if (l.kind === 'local') return `Servidor local <code>${esc(l.target)}</code> <span class="pill info">local</span>`;
  const name = l.target.slice('deployment:'.length);
  const machine = l.deployment && upOf(l.deployment)[0];
  const where = machine ? ` <small class="inl">${esc(machine.machineType)} · ${esc(machine.zone)}</small>` : '';
  const kind = l.deployment ? ` <small class="inl">${esc(providerLabel(l.deployment))}</small>` : '';
  return `${l.kind === 'own-gpu' ? 'GPU própria' : 'Outra máquina'} <a href="${detailHref({ name })}"><code>${esc(name)}</code></a>${where}${kind}${l.deployment?.pinned ? ' <span class="pill info">fixada</span>' : ''}`;
}

type Measured = 'app' | 'all' | null;

function linkFacts(l: ChainLink, measured: Measured): string {
  const facts = [
    l.probe ? `teste ${l.probe.ok ? (l.probe.content === 'mismatch' ? `respondeu, ${l.probe.contentNote ?? 'conteúdo estranho'}` : l.probe.content === 'ok' ? 'ok, conteúdo conferido' : 'ok')
      : `falhou${l.probe.code ? ` (${l.probe.code})` : ''}`} às ${hhmm(l.probe.checkedAt)} · ${ms(l.probe.latencyMs)}` : '',
    measured ? (l.p50Ms !== null ? `p50 ${ms(l.p50Ms)}` : 'p50 sem dado') : '',
    measured ? (l.share !== null ? `${pct(l.share)} da etapa em 24 h (${measured === 'app' ? 'este app' : 'todos os apps'})` : 'sem tráfego em 24 h')
      : 'sem telemetria de tráfego',
  ].filter(Boolean);
  return `<small>${esc(facts.join(' · '))}</small>`;
}

const verdictText = (svc: Service) => (svc.verdict === 'so-nuvem' && svc.level === 'ok' ? 'Só nuvem · esperado fora da aula' : VERDICT_TEXT[svc.verdict]);

function serviceBlock(svc: Service, measured: Measured): string {
  const chain = svc.links.map((l, i) => `<li class="${l.serving ? 'now' : ''}"><span class="ix">${i + 1}</span><div class="lk"><div>${linkName(l)} ${pill(l.level, l.state)}${
    l.serving ? ' <span class="pill info">atende agora</span>' : ''}${
    l.reorder ? ` <span class="pill ${l.reorder.role === 'promoted' ? 'info' : 'warn'}">${esc(l.reorder.role === 'promoted' ? l.reorder.reason : 'rebaixada')}</span>` : ''}</div>${
    linkFacts(l, measured)}</div></li>`).join('');
  const note = svc.links.some(l => l.reorder) ? '<p class="foot-note">Ordem efetiva: o gateway trocou links equivalentes (mesmo modelo ou mesma voz) pela saúde e pela latência medidas.</p>' : '';
  return `<div class="svc"><div class="svh"><b>${esc(stageName(svc.stage))}</b> <code>${esc(svc.alias)}</code>${pill(svc.level, verdictText(svc))}</div><ol class="chain">${chain}</ol>${note}</div>`;
}

export function guarantee(ctx: Ctx): Section {
  const { s } = ctx;
  const all = services(s, ctx.app, ctx.now);
  const base = { id: 'garantia', title: 'Garantia do serviço', actions: '' };
  if (!s.chains) return { ...base, level: 'ok', count: null, notes: [], meta: '', body: '<p class="empty">As cadeias de rotas não estão disponíveis neste gateway.</p>' };
  const measured: Measured = s.traffic?.byApp ? 'app' : s.traffic?.links.length ? 'all' : null;
  const apps = s.apps.filter(a => !ctx.app || a.id === ctx.app).map((app) => {
    const own = all.filter(x => x.app === app.id);
    const { name } = appTitle(app.id, app.profile);
    const lost = app.profile?.requiresGpu && own.some(x => x.verdict === 'so-nuvem' && x.level !== 'ok')
      ? '<p class="lost">Este app precisa da GPU: na nuvem ele funciona degradado. O perfil não lista o que se perde; registre em PUT /v1/apps/'
        + `${esc(app.id)}/profile.</p>` : '';
    const body = own.length ? own.map(x => serviceBlock(x, measured)).join('') : '<p class="empty">Sem rotas próprias: usa as cadeias padrão do gateway.</p>';
    return `<div class="gapp" id="garantia-${esc(app.id)}"><h3 class="sub">${mark(worst(own.map(x => x.level)))}${esc(name)}${
      app.profile?.requiresGpu ? ' <span class="t">precisa de GPU</span>' : ''}</h3>${lost}${body}</div>`;
  }).join('');
  const level = worst(all.map(x => x.level));
  const problems = all.filter(x => x.level !== 'ok');
  return {
    ...base, level, count: all.length,
    notes: problems.map(x => `${appTitle(x.app, s.apps.find(a => a.id === x.app)?.profile).name} ${stageName(x.stage)}: ${VERDICT_TEXT[x.verdict].toLowerCase()}`),
    meta: `${all.filter(x => x.verdict === 'garantido').length} de ${all.length} serviços garantidos · cadeia na ordem em que o gateway tenta`,
    body: apps || '<p class="empty">Nenhum app registrado.</p>',
  };
}
