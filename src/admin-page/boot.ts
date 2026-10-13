import type { BootLogLine, BootPhase } from '../deployments/boot-track';
import type { DeploymentView } from '../deployments/types';
import { EUR_TO_USD } from '../deployments/vast-backend';
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

export function gpuDetailBody(d: DeploymentView, log: BootLogLine[], now: number): string {
  const boot = d.boot ?? { active: [], past: [], retryAt: null, expectedBootSeconds: null };
  const b = bootOf(d);
  const head = b ? `<p class="msg" role="status">${pill(b.stuck ? 'bad' : 'warn', bootHeadline(b))}</p>` : '';
  const err = d.lastError ? `<p class="msg" role="alert"><b>Erro:</b> ${esc(d.lastError)}<br><small>${esc(nextStep(d))}</small></p>` : '';
  const active = boot.active.map(x => `<h3 class="sub">Boot em curso${x.replicaId ? ` · <code>${esc(x.replicaId)}</code>` : ''}</h3>${timeline(x.phases, true)}`).join('');
  const past = table([{ label: 'Início' }, { label: 'Réplica' }, { label: 'Duração', num: true }, { label: 'Resultado' }], boot.past.map(p => [
    hhmm(p.startedAt), p.replicaId ? `<code>${esc(p.replicaId)}</code>` : '—', duration((p.endedAt - p.startedAt) / 1000),
    p.result === 'ready' ? pill('ok', 'pronta') : pill(p.result === 'failed' ? 'bad' : 'warn', `${p.result === 'failed' ? 'falhou' : 'interrompida'}${p.reason ? ` · ${p.reason}` : ''}`),
  ]), 'Nenhum boot registrado desde que o gateway subiu.');
  const lines = log.slice(-LOG_SHOWN).map(l => `${hhmm(l.at)} ${l.replicaId ? `[${l.replicaId}] ` : ''}${l.text}`).join('\n');
  const extract = lines ? `<pre class="log">${esc(lines)}</pre>` : '<p class="empty">Nenhuma linha registrada desde que o gateway subiu.</p>';
  return `<p><a href="/admin#gpus">← Voltar às GPUs</a></p><h1 class="mono">${esc(d.name)}</h1>${head}${err}${facts(d)}${active}`
    + `<h3 class="sub">Últimos boots</h3>${past}<h3 class="sub">Extrato do log (gateway e provedor)</h3>`
    + `<p class="t">Linhas do controlador do gateway para este deployment e as mensagens de estado do provedor; o log do contêiner não é buscado. Atualizado às ${hhmm(now)}.</p>${extract}`;
}
