// ── BabelCast Gateway — Translate Race Service ───────────────────────────────
// Encapsulates the "build candidates + race + cache" loop used by
// server/ai-handlers.ts:handleTranslate. Does NOT do HTTP parsing or shadow
// mode — those stay in the adapter.

import type { AIProfile } from '../../client';
import type { RaceCandidate } from '../routing/provider-racer';
import type { GpuLLMResult } from './gpu-fetch';
import { createLogger } from '../../logger';

const log = createLogger('translate-service');

export interface TranslateServiceInput {
  text: string;
  sourceLang: string;
  targetLang: string;
  glossary: string;
  context: string;
  style: string;
  systemPrompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  gpuLlmTimeout: number;
  gpuEndpoint: string | null;
  requestId: string;
}

export interface TranslateServiceDeps {
  client: { chat(messages: TranslateServiceInput['messages'], profile: AIProfile): Promise<{ content: string }> };
  cloudProfile: AIProfile | null;
  cloudProviderName: string;
  shouldPreferGpu: () => boolean;

  raceProviders: <T>(candidates: RaceCandidate<T>[], opts: { logPrefix: string; headstartMs: number })
    => Promise<{ result: T; provider: string; latencyMs: number }>;

  fetchGpuLLM: (
    gpuEndpoint: string, text: string, sourceLang: string, targetLang: string,
    glossary: string, context: string, signal: AbortSignal, requestId?: string,
  ) => Promise<GpuLLMResult>;
}

export interface TranslateServiceResult {
  translatedText: string;
  provider: string;
  latencyMs: number;
  usedGpu: boolean;
}

/** Race GPU vs cloud for a translation request. Returns the winning result. */
export async function runTranslateRace(
  input: TranslateServiceInput,
  deps: TranslateServiceDeps,
): Promise<TranslateServiceResult> {
  const { text, sourceLang, targetLang, glossary, context: ctx, messages, maxTokens,
    gpuLlmTimeout, gpuEndpoint, requestId } = input;

  const candidates: RaceCandidate<GpuLLMResult>[] = [];

  if (gpuEndpoint && deps.shouldPreferGpu()) {
    candidates.push({
      name: 'gpu', timeoutMs: gpuLlmTimeout,
      run: (signal) => deps.fetchGpuLLM(gpuEndpoint, text, sourceLang, targetLang, glossary, ctx, signal, requestId),
    });
  }
  if (deps.cloudProfile) {
    const profile = deps.cloudProfile;
    candidates.push({
      name: deps.cloudProviderName, timeoutMs: 8_000,
      run: async (signal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const profileWithTokens = { ...profile, maxTokens, temperature: 0 };
        const result = await deps.client.chat(messages, profileWithTokens);
        return { translated_text: result.content, used_gpu: false };
      },
    });
  }
  if (gpuEndpoint && !deps.shouldPreferGpu() && candidates.length > 0) {
    candidates.push({
      name: 'gpu', timeoutMs: gpuLlmTimeout,
      run: (signal) => deps.fetchGpuLLM(gpuEndpoint, text, sourceLang, targetLang, glossary, ctx, signal, requestId),
    });
  }

  if (candidates.length === 0) {
    throw new Error('No providers available for translation');
  }

  const { result, provider, latencyMs } = await deps.raceProviders(candidates, {
    logPrefix: '[llm]', headstartMs: 0,
  });
  if (result.translated_text) {
    log.log(`Translate: '${text.slice(0, 50)}' -> '${result.translated_text.slice(0, 50)}'`);
  }

  return {
    translatedText: result.translated_text,
    provider,
    latencyMs,
    usedGpu: !!result.used_gpu,
  };
}

/** Build the system prompt with optional context + glossary addendums. */
export function buildTranslatePrompt(basePrompt: string, context: string, glossary: string): string {
  let prompt = basePrompt;
  if (context) {
    prompt += `\n\nSession context (use to improve accuracy and terminology):\n${context}`;
  }
  if (glossary) {
    prompt += `\n\nDomain-specific glossary (preserve these terms accurately):\n${glossary}`;
  }
  return prompt;
}
