import type { GpuTypeValidation, GpuValidationView } from '../deployments/gpu-validation';
import type { DeploymentView } from '../deployments/types';
import { esc, hhmm, mark, ms, money, pill, shortDate, table, type Ctx } from './ui';

function classReplicaHours(d: DeploymentView): number | null {
  const w = d.spec.warmSchedule?.[0];
  if (!w) return null;
  const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  return (((minutes(w.end) - minutes(w.start) + 1440) % 1440) / 60) * w.minReplicas;
}

const NOT_VALIDATED = 'ainda não validada nesta imagem';
const hidden = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');

function typeFields(csrf: string, back: string | undefined, name: string): string {
  return hidden({ csrf, ...(back ? { back } : {}), name });
}

function gpuTypeForm(d: DeploymentView, v: GpuValidationView | null, csrf: string, back?: string): string {
  const g = d.gpuType!;
  const hours = classReplicaHours(d);
  const cost = (cap: number) => `até ${money(cap)}/h${hours ? ` ≈ ${money(cap * hours)}/aula` : ''}`;
  const gated = Boolean(v?.gated);
  const locked = (type: string) => gated && type !== g.default && type !== g.current && !v!.types.find(t => t.machineType === type)?.validated;
  const label = (type: string, i: number) => (i ? type : g.current !== g.default ? `voltar ao padrão (${type})` : `${type} (padrão)`);
  const options = g.choices.map((c, i) => `<option value="${i ? esc(c.machineType) : ''}"${c.machineType === g.current ? ' selected' : ''}${locked(c.machineType) ? ' disabled' : ''}>`
    + `${esc(label(c.machineType, i))} · ${esc(locked(c.machineType) ? NOT_VALIDATED : cost(c.maxEurPerHour))}</option>`).join('');
  const open = g.choices.filter(c => !locked(c.machineType));
  const confirm = `Trocar ${gated ? 'a GPU padrão de produção' : 'o tipo de GPU'} de ${d.name}? Vale na próxima partida da GPU; com «trocar agora» a GPU reinicia `
    + `(~20 min fria) e a reserva da nuvem responde enquanto isso. ${open.map(c => `${c.machineType}: ${cost(c.maxEurPerHour)}`).join('; ')}.`;
  const who = g.setBy && g.setAt ? `<small>${esc(g.current)} escolhida por ${esc(g.setBy)} às ${hhmm(g.setAt)}</small>` : '';
  return `<form method="post" action="/admin/gpu-type" class="gpu-type" data-confirm="${esc(confirm)}">${typeFields(csrf, back, d.name)}`
    + `<label>${gated ? 'GPU padrão de produção' : 'Tipo de GPU'}<select name="machineType">${options}</select>`
    + `${gated ? '<small class="hint">Só os tipos validados nesta imagem podem ser escolhidos.</small>' : ''}</label>`
    + `<label class="now"><input type="checkbox" name="now" value="1"> trocar agora (reinicia a GPU, ~20 min fria)</label>`
    + `<div class="row"><button>Trocar GPU</button>${who}</div></form>`;
}

function statusCell(t: GpuTypeValidation): string {
  if (t.validated) {
    const where = [shortDate(t.validated.at), t.validated.country, t.validated.checkMs !== null ? `teste ${ms(t.validated.checkMs)}` : null].filter(Boolean).join(' · ');
    return `${pill('ok', 'validada')}<small>${esc(where)}</small>${t.validated.seed ? `<small>${esc(t.validated.seed)}</small>` : ''}`;
  }
  if (t.failed) {
    const lines = t.failed.lines.length
      ? `<details><summary>linhas do log (${t.failed.lines.length})</summary><pre class="log">${esc(t.failed.lines.join('\n'))}</pre></details>` : '';
    return `${pill('bad', `falhou em ${shortDate(t.failed.at)}`)}<small class="err">${esc(t.failed.reason)}</small>${lines}`;
  }
  return `<span class="pill nv">${NOT_VALIDATED}</span>`;
}

function testCell(d: DeploymentView, v: GpuValidationView, t: GpuTypeValidation, ctx: Ctx, back: string): string {
  if (!v.gated || t.validated || t.machineType === d.gpuType!.default) return '';
  if (v.trial?.machineType === t.machineType) return `<span class="pill warn">${mark('warn')}testando agora</span>`;
  const eur = money((t.maxEurPerHour * v.trialMinutes) / 60);
  const confirm = `Testar ${t.machineType}? Liga ${v.testCopy} numa ${t.machineType} (até ${money(t.maxEurPerHour)}/h, ≈ ${eur} em ~${v.trialMinutes} min de boot e teste), `
    + 'roda o teste de fala → texto, conversa e texto → fala e estaciona sozinha. Nunca uma segunda GPU para o app.';
  return `<form method="post" action="/admin/gpu-test" data-confirm="${esc(confirm)}">${typeFields(ctx.csrf, back, d.name)}`
    + `${hidden({ machineType: t.machineType })}<button${v.trialRefusal ? ` disabled title="${esc(v.trialRefusal)}"` : ''}>Testar nesta GPU</button>`
    + `<small>≈ ${eur} · ${money(t.maxEurPerHour)}/h × ${v.trialMinutes} min</small></form>`;
}

export function gpuTypePanel(d: DeploymentView, v: GpuValidationView | null, ctx: Ctx): string {
  const g = d.gpuType;
  if (!g || ctx.view) return '';
  const back = ctx.path ?? `/admin/gpus/${encodeURIComponent(d.name)}`;
  const hours = classReplicaHours(d);
  const types = v?.types ?? g.choices.map(c => ({ ...c, validated: null, failed: null }));
  const rows = types.map(t => [
    `<b>${esc(t.machineType)}</b>${t.machineType === g.default ? '<small>padrão declarado</small>' : ''}${t.machineType === g.current ? '<small class="cur">escolhida</small>' : ''}`,
    statusCell(t),
    `até ${money(t.maxEurPerHour)}/h${hours ? `<small>≈ ${money(t.maxEurPerHour * hours)}/aula</small>` : ''}`,
    v ? testCell(d, v, t, ctx, back) : '',
  ]);
  const pending = v?.gated && types.some(t => !t.validated && t.machineType !== g.default);
  const trial = v?.trial
    ? `<p class="msg" role="status">${pill('warn', `Testando ${v.trial.machineType}`)}<span>em ${esc(v.trial.deployment)} desde ${hhmm(v.trial.startedAt)} · `
      + `estaciona sozinha ao validar ou às ${hhmm(v.trial.deadline)}<small>pedido por ${esc(v.trial.by)}</small></span></p>` : '';
  const refusal = pending && !v!.trial && v!.trialRefusal ? `<p class="note">Testar agora não é possível: ${esc(v!.trialRefusal)}.</p>` : '';
  const lead = v?.gated
    ? `Só vai para a produção uma GPU que já rodou esta imagem: ficou pronta, passou no teste de fala → texto, conversa e texto → fala e seguiu pronta por 3 min.`
      + `${v.testCopy ? ` O teste roda em ${esc(v.testCopy)}.` : ''}`
    : v ? `Cópia de teste de ${esc(v.family)}: aceita qualquer tipo. Um boot que passa no teste valida o tipo para ${esc(v.family)}.` : '';
  const title = v?.gated ? 'GPU padrão de produção' : 'Tipo de GPU';
  return `<section id="tipo" class="gtype"><header class="sh"><h2>${title}</h2>${v ? `<span class="meta mono">${esc(v.image.split('/').pop())}</span>` : ''}</header>`
    + `${lead ? `<p class="lead"><span>${lead}</span></p>` : ''}${trial}${refusal}`
    + table([{ label: 'Tipo' }, { label: 'Validação nesta imagem' }, { label: 'Custo', num: true }, { label: 'Teste', act: true }], rows, '')
    + gpuTypeForm(d, v, ctx.csrf, back) + '</section>';
}
