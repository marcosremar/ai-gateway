/**
 * Streaming Overlap Pipeline — starts LLM inference as soon as the first
 * STT tokens arrive, rather than waiting for the full transcription.
 *
 * Traditional pipeline:
 *   audio → [STT: 500ms] → full text → [LLM: 1000ms] → full translation → [TTS: 800ms]
 *   Total: ~2300ms sequential
 *
 * Streaming overlap:
 *   audio → [STT starts] ─── partial text ──→ [LLM starts early]
 *                              ↓                    ↓
 *                         full text arrives     LLM streaming output ──→ [TTS starts]
 *   Total: ~1800ms (saving ~500ms by overlapping STT tail with LLM start)
 *
 * How it works:
 *   1. STT begins and yields partial transcriptions as they arrive
 *   2. When enough context is available (MIN_CONTEXT_TOKENS), the LLM
 *      starts generating with a "continue from..." prompt
 *   3. As the LLM streams tokens, TTS can begin on sentence boundaries
 *
 * This module provides the overlap coordinator. The actual STT/LLM/TTS
 * providers are injected via the PipelineProviders interface.
 *
 * Status: foundation — the coordinator is implemented but the proxy
 * doesn't call it yet. The existing POST /v1/speech route uses the
 * sequential pipeline in server/ai-handlers.ts. Wiring this in requires
 * a streaming STT provider (not all providers support partial results).
 */

import type { LLMProvider, ChatMessage } from '../providers/types';
import { isStreamMarker } from '../gateway/providers/cloud/openai-compat/stream-markers';

export interface StreamingOverlapOptions {
  /** Minimum tokens from STT before starting LLM. Default: 10. */
  minContextTokens?: number;
  /** System prompt for the LLM. */
  systemPrompt?: string;
  /** Source language for translation context. */
  sourceLanguage?: string;
  /** Target language for translation. */
  targetLanguage?: string;
  /** LLM model to use. */
  model?: string;
  /** Max tokens for LLM generation. */
  maxTokens?: number;
}

export interface OverlapResult {
  /** Full STT transcription. */
  transcription: string;
  /** Full LLM response. */
  translation: string;
  /** How many ms were saved by overlap vs sequential. */
  overlapSavingMs: number;
  /** Total pipeline time. */
  totalMs: number;
  /** When the LLM started relative to STT start. */
  llmStartedAtMs: number;
}

const DEFAULT_MIN_CONTEXT_TOKENS = 10;

/**
 * Run a streaming overlap pipeline where LLM starts as soon as enough
 * STT context is available.
 *
 * @param sttStream An async generator that yields partial STT text as it arrives
 * @param llmProvider The LLM provider (must support chatStream for best results)
 * @param opts Pipeline configuration
 * @returns The combined result with overlap timing
 */
export async function runStreamingOverlap(
  sttStream: AsyncGenerator<string, void, undefined>,
  llmProvider: LLMProvider,
  opts: StreamingOverlapOptions = {},
): Promise<OverlapResult> {
  const minContext = opts.minContextTokens ?? DEFAULT_MIN_CONTEXT_TOKENS;
  const t0 = Date.now();

  // Phase 1: Accumulate STT tokens until we have enough context
  let sttText = '';
  let llmStartedAtMs = 0;
  let sttDone = false;

  for await (const partial of sttStream) {
    sttText += partial;
    // Rough token estimate: ~4 chars per token for English
    const estimatedTokens = Math.ceil(sttText.length / 4);
    if (estimatedTokens >= minContext && !llmStartedAtMs) {
      llmStartedAtMs = Date.now() - t0;
      break; // enough context — start LLM
    }
  }

  // If STT finished before we reached minContext, we still have the full text
  if (!llmStartedAtMs) {
    sttDone = true;
    llmStartedAtMs = Date.now() - t0;
  }

  // Phase 2: Start LLM with the context we have so far, while STT continues
  const messages: ChatMessage[] = [];
  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: opts.systemPrompt });
  } else if (opts.sourceLanguage && opts.targetLanguage) {
    messages.push({
      role: 'system',
      content: `Translate from ${opts.sourceLanguage} to ${opts.targetLanguage}. Reply only with the translation.`,
    });
  }
  messages.push({ role: 'user', content: sttText });

  // Run LLM and remaining STT in parallel
  const llmPromise = (async () => {
    if (llmProvider.chatStream) {
      let result = '';
      for await (const token of llmProvider.chatStream({
        model: opts.model ?? '',
        messages,
        maxTokens: opts.maxTokens ?? 256,
      })) {
        // Skip the in-band markers (`__usage__:`, `__finish__:`) of chatStream
        if (isStreamMarker(token)) continue;
        result += token;
      }
      return result;
    }
    const resp = await llmProvider.chat({
      model: opts.model ?? '',
      messages,
      maxTokens: opts.maxTokens ?? 256,
    });
    return resp.content;
  })();

  // Continue draining STT if it wasn't done yet
  const sttRemainder = (async () => {
    if (sttDone) return '';
    let remainder = '';
    for await (const partial of sttStream) {
      remainder += partial;
    }
    return remainder;
  })();

  const [translation, sttRest] = await Promise.all([llmPromise, sttRemainder]);
  const fullTranscription = sttText + sttRest;

  const totalMs = Date.now() - t0;

  // Estimate how much time we saved: if sequential, LLM would have started
  // at the end of STT. We started it at llmStartedAtMs instead.
  // Rough saving = (STT total time) - llmStartedAtMs
  const sttEstimatedTotalMs = llmStartedAtMs + (sttRest.length > 0 ? 200 : 0);
  const overlapSavingMs = Math.max(0, sttEstimatedTotalMs - llmStartedAtMs);

  return {
    transcription: fullTranscription,
    translation,
    overlapSavingMs,
    totalMs,
    llmStartedAtMs,
  };
}
