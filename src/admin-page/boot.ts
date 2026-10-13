import type { BootLogLine, BootPhase } from '../deployments/boot-track';
import type { DeploymentView } from '../deployments/types';
import { EUR_TO_USD } from '../deployments/vast-backend';
import { STUCK_RETRY_MAX } from '../deployments/stuck-retry';
import { duration, esc, hhmm, money, pill, providerLabel, providerOf, table, upOf, type Level } from './ui';

export const PHASE_TEXT: Record<BootPhase, string> = {
  placing: 'procurando oferta e alugando',
  provisioning: 'máquina ligando no provedor',
  pulling: 'puxando a imagem',
  starting: 'iniciando o contêiner',
  loading: 'carregando modelos',
  ready: 'pronta',
};
export const LOG_SHOWN = 100;

type Boot = DeploymentView['boot']['active'][number];
const minutes = (m: number) => `${Math.max(0, Math.round(m))} min`;

export const bootOf = (d: DeploymentView): Boot | null => d.boot?.active.find(b => b.stuck) ?? d.boot?.active[0] ?? null;
export const bootLevel = (d: DeploymentView): Level | null => {
  const b = bootOf(d);
  return b ? (b.stuck ? 'bad' : 'warn') : null;
};

export function bootHeadline(b: Boot): string {
  return b.stuck ? `Travou em ${PHASE_TEXT[b.phase]} há ${minutes(b.phaseMinutes)}` : `Iniciando · ${PHASE_TEXT[b.phase]} há ${minutes(b.phaseMinutes)}`;
}

export function bootState(d: DeploymentView): string {
  const b = bootOf(d);
  if (!b) return '';
  const expected = d.boot?.expectedBootSeconds ? `boot típico ${duration(d.boot.expectedBootSeconds)}` : `limite ${b.timeoutMinutes} min`;
  return pill(b.stuck ? 'bad' : 'warn', b.stuck ? `Travou em ${PHASE_TEXT[b.phase]}` : 'Iniciando')
    + `<small>${esc(`${PHASE_TEXT[b.phase]} há ${minutes(b.phaseMinutes)} · esperado ${minutes(b.expectedMinutes)}`)}</small>`
    + `<small>${esc(`total ${minutes(b.totalMinutes)} · ${expected}`)}</small>`;
}

export function nextStep(d: DeploymentView): string {
  if (!d.lastError) return '';
  const e = d.lastError;
  const why = /insufficient_credit|credit/i.test(e) ? 'sem crédito no provedor' : /out_of_stock|out of stock|no vast offer/i.test(e) ? 'sem oferta disponível'
    : /boot-timeout/i.test(e) ? 'boot passou do limite' : 'falha ao criar';
  return d.boot?.retryAt ? `${why} · nova tentativa às ${hhmm(d.boot.retryAt)} (espera crescente)` : `${why} · tenta de novo no próximo ciclo`;
}

export const detailHref = (d: { name: string }) => `/admin/gpus/${encodeURIComponent(d.name)}`;

function timeline(phases: Array<{ phase: BootPhase; at: number; ms: number }>, open: boolean): string {
  const rows = phases.map((p, i) => [
    `<b>${esc(PHASE_TEXT[p.phase])}</b>`, hhmm(p.at), p.phase === 'ready' ? '—' : `${duration(p.ms / 1000)}${open && i === phases.length - 1 ? ' (em curso)' : ''}`,
  ]);
  return table([{ label: 'Fase' }, { label: 'Início', num: true }, { label: 'Duração', num: true }], rows, 'Sem fases registradas.');
}

function facts(d: DeploymentView): string {
  const r = upOf(d)[0];
  const price = r?.pricePerHour ?? null;
  const cost = price === null ? '—' : providerOf(d) === 'vast' ? `${money(price * EUR_TO_USD, 'US$')}/h (${money(price)}/h)` : `${money(price)}/h`;
  const items: Array<[string, string]> = [
    ['Provedor', providerLabel(d)], ['Réplica', r?.id ?? 'nenhuma ainda'], ['Oferta', r ? `${r.machineType} · ${r.zone}` : `${d.spec.machineType} (pedida)`],
    ['Preço', cost], ['Imagem', d.spec.image || 'script de boot'], ['Digest', 'não registrado pelo gateway'],
    ['Limite de boot', d.spec.bootTimeoutMinutes ? `${d.spec.bootTimeoutMinutes} min` : '—'], ['Última colocação', d.lastPlacement ?? '—'],
  ];
  return `<dl class="facts">${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

const panel = (title: string, meta: string, body: string) =>
  `<section><header class="sh"><h2>${esc(title)}</h2>${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</header>${body}</section>`;

export function gpuDetailBody(d: DeploymentView, log: BootLogLine[], now: number, actions = ''): string {
  const boot = d.boot ?? { active: [], past: [], retryAt: null, expectedBootSeconds: null };
  const b = bootOf(d);
  const head = b ? `<p class="msg" role="status">${pill(b.stuck ? 'bad' : 'warn', bootHeadline(b))}</p>` : '';
  const err = d.lastError ? `<p class="msg bad" role="alert"><span><b>Erro:</b> ${esc(d.lastError)}<small>${esc(nextStep(d))}</small></span></p>` : '';
  const active = boot.active.map(x => panel(`Boot em curso${x.replicaId ? ` · ${x.replicaId}` : ''}`, '', timeline(x.phases, true))).join('');
  const past = table([{ label: 'Início' }, { label: 'Réplica' }, { label: 'Duração', num: true }, { label: 'Resultado' }], boot.past.map(p => [
    hhmm(p.startedAt), p.replicaId ? `<code>${esc(p.replicaId)}</code>` : '—', duration((p.endedAt - p.startedAt) / 1000),
    p.result === 'ready' ? pill('ok', 'pronta') : pill(p.result === 'failed' ? 'bad' : 'warn', `${p.result === 'failed' ? 'falhou' : 'interrompida'}${p.reason ? ` · ${p.reason}` : ''}`),
  ]), 'Nenhum boot registrado desde que o gateway subiu.');
  const retries = boot.retries?.length ? panel('Novas tentativas automáticas', boot.retriesExhausted ? 'tentativas esgotadas: segue o limite de boot normal' : `até ${STUCK_RETRY_MAX} por boot travado`,
    table([{ label: 'O que aconteceu' }, { label: 'Quando', num: true }], [...boot.retries].reverse().map(r => [
      esc(`travou em ${PHASE_TEXT[r.phase]} (${r.minutes} min) em ${r.where} → liberada → nova tentativa ${r.attempt}/${STUCK_RETRY_MAX} `
        + (r.next ? `em ${r.next.where} (${r.next.replicaId})` : '· procurando outra oferta')),
      hhmm(r.at),
    ]), '')) : '';
  const lines = log.slice(-LOG_SHOWN).map(l => `${hhmm(l.at)} ${l.replicaId ? `[${l.replicaId}] ` : ''}${l.text}`).join('\n');
  const extract = lines ? `<pre class="log">${esc(lines)}</pre>` : '<p class="empty">Nenhuma linha registrada desde que o gateway subiu.</p>';
  return `<header class="ph"><p class="crumb"><a href="/admin/gpus">GPUs e máquinas</a> /</p><div class="pt"><h1 class="mono">${esc(d.name)}</h1>`
    + `${actions ? `<div class="acts">${actions}</div>` : ''}</div></header>${head}${err}${panel('Máquina', '', facts(d))}${active}${retries}`
    + panel('Últimos boots', '', past)
    + panel('Extrato do log', `gateway e provedor · o log do contêiner não é buscado · ${hhmm(now)}`, extract);
}
