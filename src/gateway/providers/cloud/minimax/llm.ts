/**
 * Minimax LLM Provider — MiniMax-M2 and family via /v1/text/chatcompletion_v2.
 *
 * Endpoint: POST {MINIMAX_API_BASE}/v1/text/chatcompletion_v2
 * Auth:     Authorization: Bearer <MINIMAX_API_KEY>
 *
 * Response shape mirrors OpenAI chat.completion (choices[0].message.content)
 * but adds reasoning_content / reasoning_details fields that are stripped here.
 */

import type { LLMProvider, ChatRequest, ChatResponse } from '../types';

const DEFAULT_BASE = process.env.MINIMAX_API_BASE || 'REDACTED_env_75d72190';
const DEFAULT_MODEL = 'MiniMax-M2';

interface MinimaxChoice {
  finish_reason: string;
  index: number;
  message: { role: string; content: string };
}
interface MinimaxChatResponse {
  id?: string;
  model?: string;
  choices?: MinimaxChoice[];
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  base_resp?: { status_code?: number; status_msg?: string };
}

export class MinimaxLLMProvider implements LLMProvider {
  readonly providerId = 'minimax' as const;
  private apiKey: string | null = null;
  private base: string;

  constructor(base?: string) {
    this.base = (base || DEFAULT_BASE).replace(/\/$/, '');
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
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const res = await fetch(`${this.base}/v1/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 1500,
        ...(request.responseFormat?.type === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`[minimax LLM] HTTP ${res.status}: ${body.slice(0, 300)}`), { status: res.status });
    }
    const data = await res.json() as MinimaxChatResponse;
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
      model: data.model ?? model,
      ...(usage ? { usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      } } : {}),
      raw: data,
    };
  }
}

export const minimaxLLM = new MinimaxLLMProvider();
