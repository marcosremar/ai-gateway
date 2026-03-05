/**
 * Friendly, provider-aware error messages for AI API errors.
 * Used by /api/ai-providers/chat, /stt, /tts routes.
 */

export const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  fireworks: 'Fireworks AI',
  modal: 'Modal',
  skypilot: 'SkyPilot',
  'vast-serverless': 'Vast.ai Serverless',
  runpod: 'RunPod',
  tensordock: 'TensorDock',
};

export const BILLING_URLS: Record<string, string> = {
  openai: 'platform.openai.com/settings/organization/billing',
  groq: 'console.groq.com/settings/billing',
  openrouter: 'openrouter.ai/settings/credits',
  fireworks: 'fireworks.ai/account/billing',
};

export function buildProviderError(
  providerId: string,
  status: number | undefined,
  rawMessage: string,
): { message: string; status: number } {
  const label = PROVIDER_LABELS[providerId] ?? providerId;
  const billing = BILLING_URLS[providerId] ?? '';

  switch (status) {
    case 429:
      return {
        message: billing
          ? `${label}: Limite de uso atingido (quota excedida). Verifique seu plano e faturamento em ${billing}.`
          : `${label}: Limite de uso atingido (quota excedida). Verifique seu plano.`,
        status: 429,
      };
    case 401:
      return {
        message: `${label}: Chave de API inválida ou expirada. Verifique sua chave em Configurações > Provedor de IA.`,
        status: 401,
      };
    case 402:
      return {
        message: billing
          ? `${label}: Pagamento necessário — sem créditos suficientes. Acesse ${billing}.`
          : `${label}: Pagamento necessário — sem créditos suficientes.`,
        status: 402,
      };
    case 403:
      return {
        message: `${label}: Acesso negado. Sua chave de API não tem permissão para usar este recurso.`,
        status: 403,
      };
    case 404:
      return {
        message: `${label}: Modelo não encontrado. Verifique se o modelo selecionado está disponível no seu plano.`,
        status: 404,
      };
    case 502:
    case 503:
      return {
        message: `${label}: Serviço temporariamente indisponível. Tente novamente em alguns instantes.`,
        status,
      };
  }

  if (status === 408 || rawMessage.includes('timeout') || rawMessage.includes('ETIMEDOUT')) {
    return {
      message: `${label}: Tempo de resposta esgotado. O servidor demorou demais para responder.`,
      status: 408,
    };
  }

  if (rawMessage.includes('fetch failed') || rawMessage.includes('ECONNREFUSED')) {
    return {
      message: `${label}: Não foi possível conectar ao serviço. Verifique sua conexão.`,
      status: 502,
    };
  }

  return {
    message: `${label}: ${rawMessage}`,
    status: status ?? 500,
  };
}

/**
 * Thrown when all providers in a fallback chain are credit-blocked (402).
 * Contains billing URLs so the UI can show actionable links.
 */
export class CreditExhaustedError extends Error {
  readonly status = 402;
  readonly providers: string[];
  readonly billingUrls: Record<string, string>;

  constructor(providers: string[]) {
    const labels = providers.map((p) => PROVIDER_LABELS[p] ?? p);
    const urls = providers
      .filter((p) => BILLING_URLS[p])
      .map((p) => `  ${PROVIDER_LABELS[p] ?? p}: ${BILLING_URLS[p]}`);

    const msg = urls.length > 0
      ? `Créditos esgotados em ${labels.join(', ')}. Recarregue em:\n${urls.join('\n')}`
      : `Créditos esgotados em ${labels.join(', ')}.`;

    super(msg);
    this.name = 'CreditExhaustedError';
    this.providers = providers;
    this.billingUrls = Object.fromEntries(
      providers.filter((p) => BILLING_URLS[p]).map((p) => [p, BILLING_URLS[p]]),
    );
  }
}

/** Extract HTTP status from OpenAI SDK errors or error-like objects */
export function extractErrorStatus(error: unknown): number | undefined {
  return (error as { status?: number })?.status;
}

/** Extract error message safely */
export function extractErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
