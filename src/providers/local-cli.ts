/**
 * Local CLI providers — wrap OpenAI Codex (`codex`) and Anthropic Claude Code
 * (`claude`) CLIs as gateway LLM backends. The CLIs authenticate from their
 * own keychain/OAuth, so the gateway does not need an API key.
 *
 * NOTE: stub implementation. `isConfigured()` always reports false, which
 * prevents the providers from being registered (see server/providers.ts
 * `codexLocalAvailable` / `claudeLocalAvailable` gates). The real probe (e.g.
 * `command -v codex` / `command -v claude`) belongs here once the CLIs are
 * actually shelled out to.
 */

import type { LLMProvider, ChatRequest, ChatResponse } from './types';

export const CODEX_MODELS: string[] = ['gpt-5.5'];
export const CLAUDE_MODELS: string[] = ['sonnet', 'haiku', 'opus'];
export const REASONING_LEVELS: string[] = ['low', 'medium', 'high'];

/**
 * Stub local-CLI provider. Implements the full LLMProvider surface so it can be
 * assigned to ProviderDescriptor.llm without a cast, but isConfigured() always
 * reports false — server/providers.ts gates registration on that, so chat() is
 * never reached at runtime until a real implementation lands.
 */
function makeUnconfiguredLocalLlm(providerId: string): LLMProvider {
  return {
    providerId,
    isConfigured(): boolean {
      return false;
    },
    async chat(_request: ChatRequest): Promise<ChatResponse> {
      throw new Error(`[local-cli] ${providerId} not configured — stub implementation`);
    },
  };
}

export const codexLocalLLM = makeUnconfiguredLocalLlm('local-codex');
export const claudeLocalLLM = makeUnconfiguredLocalLlm('local-claude');
