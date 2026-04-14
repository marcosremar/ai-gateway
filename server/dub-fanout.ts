// ── BabelCast Gateway — Multi-Language Dub Fan-Out ───────────────────────────
// Thin server layer that wires concrete server state + provider instances
// into the pure fanout orchestrator from src/gateway/pipeline/.

import { runFanoutOrchestrator } from '../src/gateway/pipeline/fanout-orchestrator';
import type {
  FanoutOpts,
  FanoutDeps,
  FanoutRouting,
  FanoutSideEffects,
  FanoutStageExecutors,
} from '../src/gateway/pipeline/fanout-orchestrator';
import { raceProviders } from './race-providers';
import type { RaceCandidate } from './race-providers';
import { broadcastWs, broadcastDubAudio, getActiveTargets } from './ws-state';
import { createLogger } from '../src/logger';

const log = createLogger('dub-fanout');
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
  client, groqDefaults, ollamaDefaults, translationDefaults,
  isStageCircuitClosed, shouldPreferGpuTts,
} from './providers';
import { PROVIDER_CHAIN, GPU_PROVIDERS } from './config';

export { getActiveTargets };

export { FanoutOpts };

export async function runMultiLangFanout(
  sttText: string,
  source: string,
  sttMs: number,
  sttProvider: string,
  opts: FanoutOpts,
): Promise<void> {
  const routing = buildFanoutRouting();
  const deps = buildFanoutDeps(routing);
  return runFanoutOrchestrator(sttText, source, sttMs, sttProvider, opts, deps);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function buildFanoutRouting(): FanoutRouting {
  const firstCloudIdx = PROVIDER_CHAIN.findIndex(p => p === 'groq' || p === 'ollama');
  const gpuIdx = PROVIDER_CHAIN.findIndex(p => GPU_PROVIDERS.has(p));
  const gpuBeforeCloud = gpuIdx >= 0 && (firstCloudIdx < 0 || gpuIdx < firstCloudIdx);
  const gpuEp = (gpuBeforeCloud && isGpuAvailable()) ? deployState.endpoint : undefined;
  const llmOnGpu = !!gpuEp && isStageWarm('llm') && isStageCircuitClosed('llm');
  const ttsOnGpu = !!gpuEp && shouldPreferGpuTts() && isStageCircuitClosed('tts');

  return {
    gpuEndpoint: gpuEp,
    llmOnGpu,
    ttsOnGpu,
    cloudProviderName: getCloudProviderName(),
  };
}

function buildFanoutDeps(routing: FanoutRouting): FanoutDeps {
  const baseProfile = getBaseProfile();

  const sideEffects: FanoutSideEffects = {
    broadcastSubtitle(data) {
      broadcastWs({
        type: 'subtitle:early',
        transcription: data.transcription,
        translation: data.translation,
        source: data.source, target: data.target,
        timing: data.timing,
      });
    },
    broadcastDubAudio,
  };

  const executors: FanoutStageExecutors = {
    getCachedTranslation,
    setCachedTranslation,
    buildSystemPrompt,

    buildLlmCandidates(rt, sttText, source, target, systemPrompt) {
      const candidates: RaceCandidate<GpuLLMResult>[] = [];
      if (rt.llmOnGpu) {
        const llmTimeout = adaptiveStageTimeout('llm', GPU_LLM_TIMEOUT_MS);
        candidates.push({
          name: 'gpu', timeoutMs: llmTimeout,
          run: (signal) => fetchGpuLLM(rt.gpuEndpoint!, sttText, source, target, '', '', signal),
        });
      }
      candidates.push({
        name: rt.cloudProviderName, timeoutMs: 8_000,
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
      return candidates;
    },

    buildTtsCandidates(rt, translatedText, targetName, speaker) {
      const candidates: RaceCandidate<GpuTTSResult>[] = [];
      if (rt.ttsOnGpu) {
        const ttsTimeout = adaptiveStageTimeout('tts', GPU_TTS_TIMEOUT_MS);
        candidates.push({
          name: 'gpu', timeoutMs: ttsTimeout,
          run: (signal) => fetchGpuTTS(rt.gpuEndpoint!, translatedText, targetName, speaker, signal),
        });
      }
      candidates.push({
        name: rt.cloudProviderName, timeoutMs: 8_000,
        run: async (signal) => {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const cloudVoice = speaker ? resolveVoiceForProfile(speaker, false) : undefined;
          const profile = { ...baseProfile, gpuEndpoint: undefined, language: '', ...(cloudVoice ? { voice: cloudVoice } : {}) };
          const r = await client.synthesize(translatedText, profile);
          return { audio: r.audio, contentType: r.contentType, used_gpu: false };
        },
      });
      return candidates;
    },
  };

  return {
    routing,
    sideEffects,
    executors,
    langNames,
  };
}

function getBaseProfile() {
  const firstCloudIdx = PROVIDER_CHAIN.findIndex(p => p === 'groq' || p === 'ollama');
  return (firstCloudIdx >= 0 && PROVIDER_CHAIN[firstCloudIdx] === 'ollama' && ollamaDefaults)
    ? ollamaDefaults : (groqDefaults || ollamaDefaults || translationDefaults);
}
