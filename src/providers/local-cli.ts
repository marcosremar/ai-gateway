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

import type { LLMProvider } from './types';

export const CODEX_MODELS: string[] = ['gpt-5.5'];
export const CLAUDE_MODELS: string[] = ['sonnet', 'haiku', 'opus'];
export const REASONING_LEVELS: string[] = ['low', 'medium', 'high'];

interface LocalCliLLM extends Partial<LLMProvider> {
  isConfigured(): boolean;
}

function makeUnconfiguredLocalLlm(label: string): LocalCliLLM {
  return {
    isConfigured(): boolean {
      return false;
    },
    async generate(): Promise<never> {
      throw new Error(`[local-cli] ${label} not configured — stub implementation`);
    },
  } as LocalCliLLM;
}

export const codexLocalLLM = makeUnconfiguredLocalLlm('codex');
export const claudeLocalLLM = makeUnconfiguredLocalLlm('claude');
