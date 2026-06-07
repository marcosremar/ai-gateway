/**
 * Minimax LLM Provider — MiniMax-M2 family via the OpenAI-compatible API.
 *
 * Endpoint: POST {MINIMAX_LLM_API_BASE || MINIMAX_API_BASE || https://api.minimax.io/v1}/chat/completions
 * Auth:     Authorization: Bearer <MINIMAX_API_KEY>
 *
 * The legacy /v1/text/chatcompletion_v2 API is deprecated. The compatible
 * endpoint supports current M2.7/M2.5/M2.1/M2 models and reasoning_split.
 */

import type { LLMProvider, ChatRequest, ChatResponse } from '../types';

const DEFAULT_BASE = process.env.MINIMAX_LLM_API_BASE || process.env.MINIMAX_API_BASE || 'https://api.minimax.io/v1';
const DEFAULT_MODEL = process.env.MINIMAX_LLM_MODEL || 'MiniMax-M2.7';

export const MINIMAX_LLM_MODELS = [
  'MiniMax-M3-highspeed',
  'MiniMax-M3',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.7',
  'MiniMax-M2.5-highspeed',
  'MiniMax-M2.5',
  'MiniMax-M2.1-highspeed',
  'MiniMax-M2.1',
  'MiniMax-M2',
];

interface MinimaxChoice {
  finish_reason: string;
  index: number;
  message: { role: string; content?: string | null; reasoning_details?: unknown };
}
interface MinimaxChatResponse {
  id?: string;
  model?: string;
  choices?: MinimaxChoice[];
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  base_resp?: { status_code?: number; status_msg?: string };
  error?: { message?: string; type?: string; code?: string | number; http_code?: string | number };
  request_id?: string;
}

function normalizeOpenAiCompatBase(base: string): string {
  const trimmed = base.replace(/\/$/, '');
  if (/\/(?:api\/)?v1$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

function formatMinimaxError(payload: MinimaxChatResponse, fallback = 'unknown'): string {
  const message = payload.error?.message || payload.base_resp?.status_msg || fallback;
  return payload.request_id ? `${message} (request_id: ${payload.request_id})` : message;
}

function shouldFallbackHighspeed(status: number, detail: string, model: string): boolean {
  return status === 429
    && model.endsWith('-highspeed')
    && /Token Plan Max|usage limit exceeded|2056/i.test(detail);
}

function nonHighspeedModel(model: string): string {
  return model.replace(/-highspeed$/, '');
}

async function readMinimaxError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  if (!body) return 'empty error body';
  try {
    const payload = JSON.parse(body) as MinimaxChatResponse;
    return formatMinimaxError(payload, body.slice(0, 300));
  } catch {
    return body.slice(0, 300);
  }
}

export class MinimaxLLMProvider implements LLMProvider {
  readonly providerId = 'minimax' as const;
  private apiKey: string | null = null;
  private base: string;

  constructor(base?: string) {
    this.base = normalizeOpenAiCompatBase(base || DEFAULT_BASE);
  }

  private getApiKey(): string {
    if (this.apiKey) return this.apiKey;
    const key = process.env.MINIMAX_API_KEY;
    if (!key) throw new Error('[minimax LLM] MINIMAX_API_KEY is not set');
    return key;
  }

  withApiKey(apiKey: string): MinimaxLLMProvider {
    const p = new MinimaxLLMProvider(this.base);
    p.apiKey = apiKey;
    return p;
  }

  withConfig(opts: { apiKey: string; baseURL?: string }): MinimaxLLMProvider {
    const p = new MinimaxLLMProvider(opts.baseURL || this.base);
    p.apiKey = opts.apiKey;
    return p;
  }

  isConfigured(): boolean { return !!(this.apiKey || process.env.MINIMAX_API_KEY); }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const apiKey = this.getApiKey();
    const model = request.model || DEFAULT_MODEL;
    const messages = request.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const send = async (modelName: string): Promise<ChatResponse> => {
      const res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelName,
          messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens ?? 1500,
          stream: false,
          reasoning_split: true,
          ...(request.responseFormat?.type === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
      });

      if (!res.ok) {
        const detail = await readMinimaxError(res);
        if (shouldFallbackHighspeed(res.status, detail, modelName)) {
          return send(nonHighspeedModel(modelName));
        }
        throw Object.assign(new Error(`[minimax LLM] HTTP ${res.status}: ${detail}`), { status: res.status });
      }
      const data = await res.json() as MinimaxChatResponse;
      if (data.error?.message) {
        const status = Number(data.error.http_code || data.error.code || 502);
        throw Object.assign(new Error(`[minimax LLM] ${formatMinimaxError(data)}`), { status: Number.isFinite(status) ? status : 502 });
      }
      const code = data.base_resp?.status_code;
      if (code && code !== 0) {
        const msg = data.base_resp?.status_msg ?? 'unknown';
        throw Object.assign(new Error(`[minimax LLM] code ${code}: ${msg}`), { status: code === 2056 ? 429 : 502 });
      }
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('[minimax LLM] empty content');
      const usage = data.usage;
      return {
        content,
        model: data.model ?? modelName,
        ...(usage ? { usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        } } : {}),
        raw: data,
      };
    };
    return send(model);
  }
}

export const minimaxLLM = new MinimaxLLMProvider();
