// ── BabelCast Gateway — OpenAI-compatible Chat Completions Service ───────────
// Extracted from server/ai-handlers.ts:handleChatCompletions. Resolves the
// provider/model mapping and emits an OpenAI-shaped response body.

export interface ChatProviderAdapter {
  providerId?: string;
  chat(input: {
    model: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: any;
    temperature?: number;
    maxTokens?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    responseFormat?: any;
  }): Promise<{
    model: string;
    content: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }>;
}

export interface ChatCompletionsDeps {
  /** Mapping of model name (or provider ID) → adapter. */
  chatProviders: Record<string, ChatProviderAdapter>;
  /** Fallback adapter when the requested model/provider isn't in the map. */
  fallback: ChatProviderAdapter;
  /** Default model IDs for each provider ID (e.g. "groq" → "llama-3.3-70b-versatile"). */
  providerDefaults: Record<string, string>;
  /** Adapters addressable via provider/model shorthand (e.g. "openrouter/meta-llama/..."). */
  providerAdapters?: Record<string, ChatProviderAdapter>;
}

export interface OpenAiChatResponse {
  id: string;
  object: 'chat.completion';
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop';
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Resolve the adapter + model for a chat request. If `model` is a known
 * provider ID ("groq", "fireworks"), uses the provider's default model;
 * otherwise looks up `model` directly in the providers map. Falls back to
 * `deps.fallback` when nothing matches.
 */
export function resolveChatProvider(
  model: string,
  deps: ChatCompletionsDeps,
): { provider: ChatProviderAdapter; resolvedModel: string } {
  let resolvedModel = model;
  let provider = deps.chatProviders[model];
  if (!provider) {
    const slashIdx = model.indexOf('/');
    if (slashIdx > 0) {
      const providerId = model.slice(0, slashIdx);
      const providerAdapter = deps.providerAdapters?.[providerId] || deps.chatProviders[providerId];
      if (providerAdapter) {
        resolvedModel = model.slice(slashIdx + 1);
        provider = providerAdapter;
      }
    }
  }
  if (!provider) {
    const defaultModel = deps.providerDefaults[model];
    if (defaultModel) {
      resolvedModel = defaultModel;
      provider = deps.chatProviders[defaultModel] || deps.fallback;
    } else {
      provider = deps.fallback;
    }
  }
  return { provider, resolvedModel };
}

/** Build the OpenAI-compatible JSON body for a chat.completion response. */
export function buildOpenAiChatResponse(
  requestId: string,
  result: {
    model: string;
    content: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  },
): OpenAiChatResponse {
  return {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion',
    model: result.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.content },
      finish_reason: 'stop',
    }],
    usage: result.usage
      ? {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        }
      : undefined,
  };
}
