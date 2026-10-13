export type AlertLevel = 'warn' | 'urgent';

export interface AlertMail { kind: string; level: AlertLevel; subject: string; body: string }

export const WARN_REPEAT_MS = 6 * 3_600_000;
export const URGENT_REPEAT_MS = 3_600_000;
const RESEND_URL = 'https://api.resend.com/emails';
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/;

export function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.trim().length >= 8)
    .map(([, value]) => value!.trim());
}

export function redact(text: string, secrets: string[]): string {
  let out = text.replace(/\b(sk|rk|re|pk)[-_][A-Za-z0-9_-]{12,}/g, '[segredo]').replace(/Bearer\s+\S+/gi, 'Bearer [segredo]');
  for (const s of secrets) out = out.split(s).join('[segredo]');
  return out;
}

export function createRepeatGate(now: () => number = Date.now) {
  const sentAt = new Map<string, number>();
  return (mail: Pick<AlertMail, 'kind' | 'level'>): boolean => {
    const t = now();
    const id = `${mail.kind}|${mail.level}`;
    if (t - (sentAt.get(id) ?? -Infinity) < (mail.level === 'urgent' ? URGENT_REPEAT_MS : WARN_REPEAT_MS)) return false;
    sentAt.set(id, t);
    return true;
  };
}

export function alertEmailFromEnv(env: Record<string, string | undefined>) {
  const to = (env.ALERT_EMAIL_TO ?? '').split(/[,;\s]+/).map(s => s.trim()).filter(s => s.includes('@'));
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!to.length || !apiKey) return null;
  return { apiKey, to, from: env.MAIL_FROM?.trim() || 'AI Gateway <onboarding@resend.dev>' };
}

export function createAlertMailer(opts: {
  apiKey: string; from: string; to: string[];
  secrets?: () => string[]; fetchImpl?: typeof fetch; now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const due = createRepeatGate(opts.now);

  async function deliver(mail: AlertMail): Promise<string | null> {
    const secrets = opts.secrets?.() ?? [];
    const subject = redact(`[ai-gateway] ${mail.level === 'urgent' ? 'URGENTE: ' : ''}${mail.subject}`, secrets);
    try {
      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: opts.from, to: opts.to, subject, text: redact(mail.body, secrets) }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await res.json().catch(() => ({})) as { id?: unknown };
      if (!res.ok || typeof payload.id !== 'string') throw new Error(`Resend HTTP ${res.status}`);
      opts.log?.('alert email sent', { kind: mail.kind, level: mail.level, id: payload.id });
      return payload.id;
    } catch (err) {
      opts.log?.('alert email failed', { kind: mail.kind, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  return {
    deliver,
    async send(mail: AlertMail): Promise<string | null> {
      return due(mail) ? deliver(mail) : null;
    },
  };
}

export type AlertMailer = ReturnType<typeof createAlertMailer>;

const OPS_TEXT: Record<string, { level: AlertLevel; subject: string; todo: string }> = {
  'provider.credit_exhausted': { level: 'urgent', subject: 'crédito do provedor esgotado', todo: 'Recarregue a conta do provedor (Vast: https://cloud.vast.ai/billing/) e desligue máquinas que ninguém usa.' },
  'deployment.create_failed': { level: 'warn', subject: 'criação de máquina falhou', todo: 'Veja o erro abaixo e o /health?details=1; o gateway tenta de novo sozinho.' },
  'deployment.stuck_boot': {
    level: 'urgent', subject: 'GPU travou no boot e as novas tentativas automáticas também',
    todo: 'Abra a GPU no painel (/admin/gpus/<nome>): o serviço segue na reserva na nuvem. O gateway volta ao limite de boot normal; troque a oferta ou desligue a nova tentativa com PATCH /v1/deployments/<nome> {"autoRetryStuckBoot": false}.',
  },
  'deployment.out_of_stock': { level: 'warn', subject: 'sem estoque de GPU', todo: 'O gateway tenta o próximo lugar da escada; se repetir, amplie as zonas/placements do deployment.' },
  'replica.lost_with_sessions': { level: 'urgent', subject: 'réplica caiu com alunos conectados', todo: 'Confira se os alunos reconectaram (/health?details=1, realtime) e por que a máquina caiu.' },
  'stage.reserve_down': { level: 'warn', subject: 'reserva de um estágio sem chave ou fora do ar', todo: 'Grave a chave que falta na API dev (bun run sandbox:set) e reinicie o gateway.' },
  'gpu.outside_window': { level: 'warn', subject: 'GPU ligada fora da janela de aula há mais de 30 min', todo: 'Veja quem a acordou (/health?details=1, gasto por chave) e estacione-a (POST /v1/deployments/<nome>/park) se ninguém usa.' },
  'gpu.idle': { level: 'warn', subject: 'GPU ligada e sem uso', todo: 'Ninguém a usa desde o último pedido: estacione-a no /admin (GPUs › Estacionar) ou em POST /v1/deployments/<nome>/park.' },
  'turn.slow': { level: 'warn', subject: 'turno lento: p95 acima de 3 s nos últimos 15 min', todo: 'Veja /health?details=1 (latency, fallback): a GPU pode estar fria ou saturada e a reserva servindo.' },
  'fallback.probe_failed': { level: 'warn', subject: 'reserva na nuvem falhou no teste automático', todo: 'Veja fallbackProbe em /health?details=1: recarregue o crédito, troque a chave (API dev) ou o modelo/voz da reserva no alias do app.' },
  'voice.turn_failing': {
    level: 'urgent', subject: 'aula: turnos de voz falhando (10 % ou mais em 10 min)',
    todo: 'Abra o painel (/admin): o cartão «Aula em curso» mostra a etapa, o motivo e o request id de cada falha, que leva ao log do gateway.',
  },
  'voice.turn_slow': {
    level: 'urgent', subject: 'aula: turnos de voz lentos (p95 acima de 4 s em 10 min)',
    todo: 'Abra o painel (/admin): veja no cartão «Aula em curso» as etapas degradadas e, em Serviços, se a GPU caiu para a reserva na nuvem.',
  },
  'stage.no_link': { level: 'urgent', subject: 'um estágio ficou sem nenhum provedor servindo', todo: 'Veja a cadeia em /health?details=1 e grave a chave que falta na API dev.' },
};

function plainFields(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => `- ${k}: ${String(v).slice(0, 300)}`)
    .join('\n');
}

export function opsAlertMail(alert: { event: string; data: Record<string, unknown> }): AlertMail | null {
  const text = OPS_TEXT[alert.event];
  if (!text) return null;
  const key = String(alert.data.provider ?? alert.data.deployment ?? alert.data.stage ?? alert.data.app ?? '');
  const subject = `${text.subject}${key ? ` (${key})` : ''}`;
  return { kind: `${alert.event}|${key}`, level: text.level, subject, body: `${subject}.\n\n${plainFields(alert.data)}\n\nO que fazer: ${text.todo}` };
}
