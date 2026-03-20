// ── BabelCast Gateway — Multi-Language Dub Fan-Out ───────────────────────────
// Parallel LLM+TTS for multiple target languages after a single STT pass.
// Called from pipeline-runner.ts after STT completes.

import { raceProviders } from './race-providers';
import type { RaceCandidate } from './race-providers';
import { broadcastWs, broadcastDubAudio, getActiveTargets } from './ws-state';
import {
  getCachedTranslation, setCachedTranslation,
  buildSystemPrompt, getCloudProviderName,
  fetchGpuLLM, fetchGpuTTS,
  resolveVoiceForProfile,
  adaptiveStageTimeout,
  GPU_LLM_TIMEOUT_MS, GPU_TTS_TIMEOUT_MS,
  type GpuLLMResult, type GpuTTSResult,
} from './ai-handlers';
import { langNames } from './http-utils';
import { deployState, isGpuAvailable, isStageWarm } from './state';
import {
  client, groqProfile, ollamaProfile, translationProfile,
  isStageCircuitClosed, shouldPreferGpuTts,
} from './providers';
import { PROVIDER_CHAIN, GPU_PROVIDERS } from './config';

export { getActiveTargets };

interface FanoutOpts {
  speaker?: string;
  style?: string;
  targets: string[];
}

export async function runMultiLangFanout(
  sttText: string,
  source: string,
  sttMs: number,
  _sttProvider: string,
  opts: FanoutOpts,
): Promise<void> {
  const { targets, speaker, style = 'default' } = opts;
  if (targets.length === 0) return;

  console.log(`[dub-fanout] Fan-out for ${targets.length} targets: [${targets.join(',')}]`);

  // Resolve GPU/cloud routing once (shared across all targets)
  const firstCloudIdx = PROVIDER_CHAIN.findIndex(p => p === 'groq' || p === 'ollama');
  const gpuIdx = PROVIDER_CHAIN.findIndex(p => GPU_PROVIDERS.has(p));
  const gpuBeforeCloud = gpuIdx >= 0 && (firstCloudIdx < 0 || gpuIdx < firstCloudIdx);
  const gpuEp = (gpuBeforeCloud && isGpuAvailable()) ? deployState.endpoint : undefined;
  const llmOnGpu = !!gpuEp && isStageWarm('llm') && isStageCircuitClosed('llm');
  const ttsOnGpu = !!gpuEp && shouldPreferGpuTts() && isStageCircuitClosed('tts');

  const baseProfile = (firstCloudIdx >= 0 && PROVIDER_CHAIN[firstCloudIdx] === 'ollama' && ollamaProfile)
    ? ollamaProfile : (groqProfile || ollamaProfile || translationProfile);

  // Run all targets in parallel
  await Promise.allSettled(targets.map(async (target) => {
    const t0 = Date.now();
    const sourceName = langNames[source] || source;
    const targetName = langNames[target] || target;

    try {
      // ── LLM Translation ──
      const cached = getCachedTranslation(sttText, source, target, style);
      let translatedText = '';
      let llmProvider = '';
      let llmMs = 0;

      if (cached !== null) {
        translatedText = cached;
        llmProvider = 'cache';
      } else {
        const systemPrompt = buildSystemPrompt(sourceName, targetName, style);
        const llmCandidates: RaceCandidate<GpuLLMResult>[] = [];

        if (llmOnGpu) {
          const llmTimeout = adaptiveStageTimeout('llm', GPU_LLM_TIMEOUT_MS);
          llmCandidates.push({
            name: 'gpu', timeoutMs: llmTimeout,
            run: (signal) => fetchGpuLLM(gpuEp!, sttText, source, target, '', '', signal),
          });
        }
        llmCandidates.push({
          name: getCloudProviderName(), timeoutMs: 8_000,
          run: async (signal) => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const messages = [
              { role: 'system' as const, content: systemPrompt },
              { role: 'user' as const, content: sttText },
            ];
            const profile = { ...baseProfile, gpuEndpoint: undefined, language: source };
            const r = await client.chat(messages, profile);
            return { translated_text: r.content, used_gpu: false };
          },
        });

        const llmRace = await raceProviders(llmCandidates, { logPrefix: `[dub-llm:${target}]` });
        translatedText = llmRace.result.translated_text;
        llmProvider = llmRace.provider;
        llmMs = Date.now() - t0;

        if (translatedText) setCachedTranslation(sttText, source, target, translatedText, style);
      }

      if (!translatedText.trim()) return;

      // Broadcast subtitle for this target language
      broadcastWs({
        type: 'subtitle:early',
        transcription: sttText,
        translation: translatedText,
        source, target,
        timing: { stt_ms: sttMs, llm_ms: llmMs },
      });

      // ── TTS Synthesis ──
      const ttsT0 = Date.now();
      const ttsCandidates: RaceCandidate<GpuTTSResult>[] = [];

      if (ttsOnGpu) {
        const ttsTimeout = adaptiveStageTimeout('tts', GPU_TTS_TIMEOUT_MS);
        ttsCandidates.push({
          name: 'gpu', timeoutMs: ttsTimeout,
          run: (signal) => fetchGpuTTS(gpuEp!, translatedText, targetName, speaker || 'Ryan', signal),
        });
      }
      ttsCandidates.push({
        name: getCloudProviderName(), timeoutMs: 8_000,
        run: async (signal) => {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const cloudVoice = speaker ? resolveVoiceForProfile(speaker, false) : undefined;
          const profile = { ...baseProfile, gpuEndpoint: undefined, language: source, ...(cloudVoice ? { voice: cloudVoice } : {}) };
          const r = await client.synthesize(translatedText, profile);
          return { audio: r.audio, contentType: r.contentType, used_gpu: false };
        },
      });

      const ttsRace = await raceProviders(ttsCandidates, { logPrefix: `[dub-tts:${target}]` });
      const ttsMs = Date.now() - ttsT0;
      const ttsAudioBuffer = ttsRace.result.audio;
      const audioB64 = ttsAudioBuffer.toString('base64');
      const totalMs = Date.now() - t0;

      // Send dubbed audio only to clients subscribed to this target
      broadcastDubAudio(target, {
        type: 'dub:audio',
        target,
        audio: audioB64,
        transcription: sttText,
        translation: translatedText,
        timing: { stt_ms: sttMs, llm_ms: llmMs, tts_ms: ttsMs, total_ms: totalMs },
      }, ttsAudioBuffer);

      console.log(`[dub-fanout] ${target}: ${totalMs}ms (LLM=${llmMs}ms[${llmProvider}] TTS=${ttsMs}ms[${ttsRace.provider}])`);
    } catch (err) {
      console.warn(`[dub-fanout] ${target} failed:`, err instanceof Error ? err.message : err);
    }
  }));
}
