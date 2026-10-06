// ── BabelCast Gateway — Provider Instances ───────────────────────────────────
// Provider availability flags, instances, registry, profiles, client.
// gateway-server.ts sets these at startup.

import { createLogger } from '../src/logger';
import { groqSTT, groqLLM, groqTTS } from '../src/providers/groq';
import { ollamaSTT, ollamaLLM, OllamaLLMProvider, OllamaSTTProvider } from '../src/providers/ollama';
import { openaiSTT } from '../src/providers/openai';
import { OpenAITTSProvider } from '../src/providers/openai/openai-tts';
import { fireworksSTT, fireworksLLM } from '../src/providers/fireworks';
import { deepgramSTT } from '../src/providers/deepgram';
import { elevenlabsSTT } from '../src/providers/elevenlabs';
import { modalTTS } from '../src/providers/modal';
import { minimaxTTS, minimaxLLM } from '../src/providers/minimax';
export { minimaxTTS, minimaxLLM };
import { modalMossTTS } from '../src/providers/modal-moss';
import { modalSeamlessSTT, modalSeamlessLLM } from '../src/providers/modal-seamless';
import { qwen3asrPipelineSTT, qwen3asrPipelineLLM } from '../src/providers/modal-qwen3asr-pipeline';
import { modalVoxtralSTT } from '../src/providers/modal-voxtral';
import { MlxQwen3AsrProvider, mlxQwen3AsrSTT } from '../src/providers/mlx-qwen3-asr';
import { openrouterQwen3Embedding } from '../src/providers/openrouter/openrouter-embedding';
import { openrouterLLM } from '../src/providers/openrouter';
export { openrouterLLM };
import {
  codexLocalLLM,
  claudeLocalLLM,
  CODEX_MODELS,
  CLAUDE_MODELS,
  REASONING_LEVELS,
} from '../src/providers/local-cli';
import { openaiEmbedding } from '../src/providers/openai/openai-embedding';
import { AIProviderRegistry } from '../src/providers/registry';
import { createAIClient } from '../src/client';
import type { AIProfile } from '../src/client';
import { PerformanceRanker } from '../src/providers/performance-ranker';
import { AdaptiveTimeoutCalculator } from '../src/providers/adaptive-timeout';
import { TtfacTracker } from '../src/providers/ttfac-tracker';
import type { ProviderMapping } from '../src/proxy/types';
import type { ProviderId } from '../src/providers/types';
import { RunpodClient } from '../src/gpu-providers/runpod-client';
import { VastClient } from '../src/gpu-providers/vast-client';
import { VastVmClient } from '../src/gpu-providers/vast-vm';
import { TensordockClient } from '../src/gpu-providers/tensordock-client';
import { ModalClient } from '../src/gpu-providers/modal-client';
import { SnapgpuClient } from '../src/gpu-providers/snapgpu-client';
import { HyperstackClient } from '../src/gpu-providers/hyperstack';
import { GpuProviderRegistry } from '../src/gpu-providers/registry';
import { ScalewayClient } from '../src/cpu-providers/scaleway-client';
import { FlyioClient } from '../src/cpu-providers/flyio-client';
import { RailwayClient } from '../src/cpu-providers/railway-client';
import {
  latencyRing, latencyRingIdx, setLatencyRingIdx, deployState, gpuHealthy, setGpuHealthy,
  isGpuAvailable, isGpuLatencyAcceptable,
  isTtsWarm, ttsWarmth, getColdStartProfile,
  isStageWarm, gpuModelWarmth,
  setGpuReadyForProduction, setGpuShadowMode, gpuShadowMode, resetGpuReadinessState, setGpuReadinessState,
} from './state';
import { runGpuReadinessCheck, resetReadinessCheck, isReadinessCheckInProgress, shouldRunGpuReadinessCheck } from './gpu-readiness';
import { RUNPOD_ENDPOINT, PROVIDER_CHAIN } from './config';
import { broadcastProviderStatus } from './ws-state';

const log = createLogger('providers');

// ── Per-provider latency tracking for adaptive routing ─────────────────────
const providerLatencyTracker: Record<string, { samples: number[]; lastDemotedAt: number }> = {};
const PROVIDER_LATENCY_RING_SIZE = 30;

export function recordProviderLatency(provider: string, stage: string, latencyMs: number): void {
  const key = `${provider}:${stage}`;
  if (!providerLatencyTracker[key]) providerLatencyTracker[key] = { samples: [], lastDemotedAt: 0 };
  const tracker = providerLatencyTracker[key];
  if (tracker.samples.length >= PROVIDER_LATENCY_RING_SIZE) tracker.samples.shift();
  tracker.samples.push(latencyMs);
}

export function getProviderP95(provider: string, stage: string): number | null {
  const key = `${provider}:${stage}`;
  const tracker = providerLatencyTracker[key];
  if (!tracker || tracker.samples.length < 5) return null;
  const sorted = [...tracker.samples].sort((a, b) => a - b);
  // Nearest-rank percentile: ceil(N * P) - 1. Math.floor used to land
  // on N when N*0.95 was an integer (e.g. N=20 → floor(19)=19 picks the
  // max), which made the P95 leak in a single outlier. Clamp to >=0
  // for tiny samples just in case.
  const idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

// ── Provider availability ────────────────────────────────────────────────────

export let groqAvailable = !!process.env.GROQ_API_KEY;
export let openaiAvailable = !!process.env.OPENAI_API_KEY;
export let deepgramAvailable = !!process.env.DEEPGRAM_API_KEY;
export let fireworksAvailable = !!process.env.FIREWORKS_API_KEY;
export let elevenlabsAvailable = !!process.env.ELEVENLABS_API_KEY;
export let openrouterAvailable = !!process.env.OPENROUTER_API_KEY;
export let groqSttModel = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
export let groqLlmModel = process.env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile';
export let groqTtsModel = process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english';
export let groqTtsVoice = process.env.GROQ_TTS_VOICE || 'autumn';
export const ollamaHost = process.env.OLLAMA_HOST || '';
export const whisperHost = process.env.WHISPER_HOST || '';
export const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2';
export let ollamaAvailable = !!ollamaHost && PROVIDER_CHAIN.includes('ollama');
// Ensemble STT: whisper is available for ensemble independently of ollama LLM chain
export let whisperAvailable = !!whisperHost;
// MLX Qwen3-ASR: local Apple Silicon STT (mlx-qwen3-asr serve)
export const mlxQwenHost = process.env.MLX_QWEN3_ASR_HOST || '';
export const mlxQwenApiKey = process.env.MLX_QWEN3_ASR_API_KEY || '';
export let mlxQwenAvailable = !!mlxQwenHost;
// ENSEMBLE_STT_PROVIDERS: comma-separated list of providers to include (default: all configured)
// Values: groq, openai, deepgram, fireworks, whisper — or "all" to use every configured provider
export const ENSEMBLE_STT_PROVIDERS = (process.env.ENSEMBLE_STT_PROVIDERS || 'all')
  .toLowerCase().split(',').map((s: string) => s.trim()).filter(Boolean);

// Build providers mapping (used by proxy for direct model routing)
export const providers: ProviderMapping = { stt: {}, chat: {} };

/** Mask a secret key for safe logging: shows first 3 + last 3 chars for keys >= 8, otherwise '***'. */
export function maskKey(key: string): string {
  if (key.length >= 8) {
    return `${key.slice(0, 3)}***${key.slice(-3)}`;
  }
  return '***';
}

function acceptsOpenRouterPassthroughModel(model: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(model);
}

function openRouterUpstreamModel(model: string): string {
  return model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
}

async function listOpenRouterModels(): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`OpenRouter models failed: ${response.status}`);
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  return (payload.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function enableOpenRouterPassthrough(): void {
  providers.chatDynamicRoutes = [{
    providerId: 'openrouter',
    provider: openrouterLLM,
    acceptsModel: acceptsOpenRouterPassthroughModel,
    upstreamModel: openRouterUpstreamModel,
  }];
  providers.dynamicModelCatalogs = [{
    providerId: 'openrouter',
    listModels: listOpenRouterModels,
  }];
}

if (groqAvailable) {
  providers.stt!['whisper-large-v3'] = groqSTT;
  providers.stt!['whisper-large-v3-turbo'] = groqSTT;
  providers.chat!['llama-3.3-70b-versatile'] = groqLLM;
  providers.chat!['llama-3.1-8b-instant'] = groqLLM;
  log.log(`Groq key: ${maskKey(process.env.GROQ_API_KEY!)}`);
}

export let ollamaLLMProvider: OllamaLLMProvider | null = null;
export let ollamaSTTProvider: OllamaSTTProvider | null = null;
if (ollamaAvailable) {
  ollamaLLMProvider = new OllamaLLMProvider(ollamaHost, ollamaModel);
  ollamaSTTProvider = new OllamaSTTProvider(whisperHost);
  providers.stt!['whisper-large-v3'] = providers.stt!['whisper-large-v3'] || ollamaSTTProvider;
  providers.stt!['whisper-large-v3-turbo'] = providers.stt!['whisper-large-v3-turbo'] || ollamaSTTProvider;
  providers.chat![ollamaModel] = ollamaLLMProvider;
  providers.chat!['llama-3.3-70b-versatile'] = providers.chat!['llama-3.3-70b-versatile'] || ollamaLLMProvider;
  providers.chat!['llama-3.1-8b-instant'] = providers.chat!['llama-3.1-8b-instant'] || ollamaLLMProvider;
  log.log(`Ollama LLM: ${ollamaHost} (model: ${ollamaModel})`);
  log.log(`Whisper STT: ${whisperHost}`);
}

// MLX Qwen3-ASR local STT
export let mlxQwenProvider: MlxQwen3AsrProvider | null = null;
if (mlxQwenAvailable) {
  const baseURL = mlxQwenHost.endsWith('/v1') ? mlxQwenHost : `${mlxQwenHost.replace(/\/$/, '')}/v1`;
  mlxQwenProvider = new MlxQwen3AsrProvider(baseURL, mlxQwenApiKey || undefined);
  providers.stt!['qwen3-asr'] = mlxQwenProvider;
  providers.stt!['qwen3-asr-0.6b-4bit'] = mlxQwenProvider;
  providers.stt!['qwen3-asr-0.6b'] = mlxQwenProvider;
  log.log(`MLX Qwen3-ASR: ${mlxQwenHost} (local Apple Silicon STT)`);
}

if (elevenlabsAvailable) log.log(`ElevenLabs key: ${maskKey(process.env.ELEVENLABS_API_KEY!)} (STT: scribe_v2)`);
if (openaiAvailable) log.log(`OpenAI key: ${maskKey(process.env.OPENAI_API_KEY!)} (ensemble STT: gpt-4o-transcribe, embedding fallback: text-embedding-3-small)`);
if (deepgramAvailable) log.log(`Deepgram key: ${maskKey(process.env.DEEPGRAM_API_KEY!)} (ensemble STT: nova-3)`);
if (fireworksAvailable) log.log(`Fireworks key: ${maskKey(process.env.FIREWORKS_API_KEY!)} (ensemble STT: whisper-v3)`);
if (openrouterAvailable) {
  enableOpenRouterPassthrough();
  log.log(`OpenRouter key: ${maskKey(process.env.OPENROUTER_API_KEY!)} (embedding fallback 1: qwen3-embedding-0.6b; chat: dynamic passthrough)`);
}
if (whisperAvailable && !ollamaAvailable) log.log(`Whisper STT (ensemble): ${whisperHost}`);
log.log(`Ensemble STT providers: ${ENSEMBLE_STT_PROVIDERS.join(',') || 'all'}`);

if (!groqAvailable && !ollamaAvailable && !fireworksAvailable) {
  // Must have at least one cloud/local LLM provider
  log.error('No LLM provider configured. Set GROQ_API_KEY, FIREWORKS_API_KEY, or OLLAMA_HOST+PROVIDER_CHAIN=ollama');
  // Allow tests / scripts that legitimately load this module without an LLM
  // provider configured (e.g. orphan-recovery unit tests) to skip the hard
  // exit. The check still runs in real startup unless explicitly disabled.
  if (process.env.AIGW_ALLOW_NO_LLM !== '1' && process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
    process.exit(1);
  }
}

if (fireworksAvailable) {
  // Fireworks LLM — used as primary when Groq is absent, fallback otherwise
  providers.chat!['accounts/fireworks/models/llama-v3p3-70b-instruct'] = fireworksLLM;
  providers.chat!['accounts/fireworks/models/llama-v3p1-70b-instruct'] = fireworksLLM;
}

// Build LLM fallback chain: Groq → Fireworks → Ollama (ordered by latency)
import type { ChatFallbackEntry } from '../src/proxy/types';
const chatFallbackChain: ChatFallbackEntry[] = [];
if (groqAvailable) {
  chatFallbackChain.push({ providerId: 'groq', model: groqLlmModel, provider: groqLLM });
}
if (fireworksAvailable) {
  chatFallbackChain.push({ providerId: 'fireworks', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', provider: fireworksLLM });
}
if (ollamaAvailable && ollamaLLMProvider) {
  chatFallbackChain.push({ providerId: 'ollama', model: ollamaModel, provider: ollamaLLMProvider });
}
providers.chatFallbackChain = chatFallbackChain;
log.log(`LLM fallback chain: ${chatFallbackChain.map(e => e.providerId).join(' → ') || 'none'}`);

// ── AIClient for voice dubbing pipeline ─────────────────────────────────────

export const registry = new AIProviderRegistry();
if (groqAvailable) {
  registry.register({
    id: 'groq',
    name: 'Groq',
    description: 'Groq Cloud LPU inference',
    capabilities: ['stt', 'llm', 'tts'],
    requiresApiKey: true,
    stt: groqSTT,
    llm: groqLLM,
    tts: groqTTS,
  });
}
if (ollamaAvailable) {
  registry.register({
    id: 'ollama',
    name: 'Ollama',
    description: 'Local Ollama + faster-whisper inference',
    capabilities: ['stt', 'llm'],
    requiresApiKey: false,
    stt: ollamaSTTProvider!,
    llm: ollamaLLMProvider!,
  });
}
// Modal TTS — always available (no API key, serverless GPU, multilingual Qwen3-TTS)
registry.register({
  id: 'modal',
  name: 'Modal',
  description: 'Modal serverless GPU TTS (Qwen3-TTS, multilingual, ~11s cold start)',
  capabilities: ['tts'],
  requiresApiKey: false,
  tts: modalTTS,
});
log.log('Modal TTS registered (Qwen3-TTS, no API key needed)');

// Minimax — speech-02 TTS + MiniMax-M2 LLM, requires MINIMAX_API_KEY
const minimaxAvailable = !!process.env.MINIMAX_API_KEY;
if (minimaxAvailable) {
  registry.register({
    id: 'minimax' as ProviderId,
    name: 'Minimax',
    description: 'Minimax (TTS: speech-02 + LLM: MiniMax-M2)',
    capabilities: ['tts', 'llm'],
    requiresApiKey: true,
    tts: minimaxTTS,
    llm: minimaxLLM,
  });
  log.log('Minimax TTS + LLM registered (MINIMAX_API_KEY present)');
} else {
  log.log('Minimax skipped (MINIMAX_API_KEY not set)');
}

// Modal SeamlessM4T v2 — ASR + speech/text translation (no API key, serverless GPU)
registry.register({
  id: 'modal-seamless',
  name: 'Modal SeamlessM4T',
  description: 'Modal serverless GPU — SeamlessM4T v2 (ASR + speech/text translation, 100+ languages)',
  capabilities: ['stt', 'llm'],
  requiresApiKey: false,
  stt: modalSeamlessSTT,
  llm: modalSeamlessLLM,
});
log.log('Modal SeamlessM4T v2 registered (STT + translation, no API key needed)');

// Modal Qwen3-ASR + TranslateGemma pipeline — best ASR + translation (no API key)
registry.register({
  id: 'modal-qwen3asr-pipeline',
  name: 'Modal Qwen3-ASR Pipeline',
  description: 'Modal serverless GPU — Qwen3-ASR 1.7B + TranslateGemma 12B (best ASR + translation)',
  capabilities: ['stt', 'llm'],
  requiresApiKey: false,
  stt: qwen3asrPipelineSTT,
  llm: qwen3asrPipelineLLM,
});
log.log('Modal Qwen3-ASR Pipeline registered (STT + LLM translation, no API key needed)');

// Modal Voxtral — Mistral open-weights ASR (no API key, 13 languages, Apache 2.0)
registry.register({
  id: 'modal-voxtral' as ProviderId,
  name: 'Modal Voxtral',
  description: 'Modal serverless GPU — Voxtral-Mini-3B (Mistral ASR, 13 languages, Apache 2.0)',
  capabilities: ['stt'],
  requiresApiKey: false,
  stt: modalVoxtralSTT,
});
log.log('Modal Voxtral registered (STT, no API key needed)');

// MLX Qwen3-ASR — local Apple Silicon STT (4-bit or fp16, no API key needed)
if (mlxQwenAvailable && mlxQwenProvider) {
  registry.register({
    id: 'mlx-qwen3-asr',
    name: 'MLX Qwen3-ASR',
    description: 'Local Apple Silicon — Qwen3-ASR (4-bit: 55x RT, fp16: 12x RT, 30 languages)',
    capabilities: ['stt'],
    requiresApiKey: false,
    stt: mlxQwenProvider,
  });
  log.log('MLX Qwen3-ASR registered (local STT, Apple Silicon Metal GPU)');
}

// Fireworks AI — STT (ensemble) + LLM (primary when Groq absent)
if (fireworksAvailable) {
  registry.register({
    id: 'fireworks' as ProviderId,
    name: 'Fireworks AI',
    description: 'Fireworks AI (STT: whisper-v3, LLM: Llama-3.3-70B)',
    capabilities: ['stt', 'llm'],
    requiresApiKey: true,
    stt: fireworksSTT,
    llm: fireworksLLM,
  });
  log.log(`Fireworks registered (STT + LLM${groqAvailable ? ', Groq is primary LLM' : ' — Groq absent, Fireworks is primary LLM'})`);
}

// OpenAI STT + TTS
export const openaiTTS = openaiAvailable ? new OpenAITTSProvider() : null;
if (openaiAvailable) {
  const existing = registry.getProvider('openai');
  if (existing) {
    existing.stt = openaiSTT;
    if (!existing.capabilities.includes('stt')) existing.capabilities.push('stt');
    if (openaiTTS) {
      existing.tts = openaiTTS;
      if (!existing.capabilities.includes('tts')) existing.capabilities.push('tts');
    }
  } else {
    registry.register({
      id: 'openai',
      name: 'OpenAI',
      description: 'OpenAI API (GPT-4o Transcribe + TTS)',
      capabilities: ['stt', ...(openaiTTS ? ['tts' as const] : [])],
      requiresApiKey: true,
      stt: openaiSTT,
      ...(openaiTTS ? { tts: openaiTTS } : {}),
    });
  }
  log.log('OpenAI registered (STT: gpt-4o-transcribe, TTS: fallback)');
}

// Local-CLI LLMs — codex and claude binaries running on this host. Auth comes
// from each CLI's own keychain/OAuth, so no API key is required at the gateway.
// Probed at boot via `command -v <bin>`; falls through silently when missing.
export const codexLocalAvailable = codexLocalLLM.isConfigured();
export const claudeLocalAvailable = claudeLocalLLM.isConfigured();
if (codexLocalAvailable) {
  registry.register({
    id: 'local-codex' as ProviderId,
    name: 'Local Codex CLI',
    description: 'OpenAI Codex CLI (gpt-5.5) running on this host',
    capabilities: ['llm'],
    requiresApiKey: false,
    llm: codexLocalLLM,
  });
  // Expose every codex model × reasoning-level combination so the proxy's
  // model→provider map can route them. The provider's modelAliases strips
  // the `codex-` prefix and reasoning suffix back to the CLI's real model.
  for (const m of CODEX_MODELS) {
    providers.chat![`codex-${m}`] = codexLocalLLM;
    for (const level of REASONING_LEVELS) {
      providers.chat![`codex-${m}-${level}`] = codexLocalLLM;
    }
  }
  providers.chat!['codex-local'] = codexLocalLLM;
  log.log(`Local Codex CLI registered (models: ${CODEX_MODELS.join(',')}, levels: ${REASONING_LEVELS.join(',')}, bin: ${process.env.LOCAL_CODEX_BIN || 'codex'})`);
}
if (claudeLocalAvailable) {
  registry.register({
    id: 'local-claude' as ProviderId,
    name: 'Local Claude Code',
    description: 'Claude Code CLI (sonnet/haiku/opus) running on this host',
    capabilities: ['llm'],
    requiresApiKey: false,
    llm: claudeLocalLLM,
  });
  for (const m of CLAUDE_MODELS) {
    providers.chat![`claude-${m}`] = claudeLocalLLM;
    for (const level of REASONING_LEVELS) {
      providers.chat![`claude-${m}-${level}`] = claudeLocalLLM;
    }
  }
  providers.chat!['claude-local'] = claudeLocalLLM;
  log.log(`Local Claude Code registered (models: ${CLAUDE_MODELS.join(',')}, levels: ${REASONING_LEVELS.join(',')}, bin: ${process.env.LOCAL_CLAUDE_BIN || 'claude'})`);
}

// ElevenLabs Scribe STT — highest accuracy (2.3% WER)
if (elevenlabsAvailable) {
  registry.register({
    id: 'elevenlabs' as ProviderId,
    name: 'ElevenLabs',
    description: 'ElevenLabs Scribe — highest accuracy STT',
    capabilities: ['stt'],
    requiresApiKey: true,
    stt: elevenlabsSTT,
  });
  log.log('ElevenLabs Scribe registered (STT)');
}

// TTS fallback chain: Modal Qwen3-TTS first (multilingual + voice cloning), Groq fallback, OpenAI backup
// Modal is free and supports 10 languages + voice cloning via reference_audio.
// Groq Orpheus is English-only and no cloning, but faster and always available.
let ttsChain = [
  { provider: 'modal', model: 'qwen3-tts' },
  { provider: 'groq', model: groqTtsModel, voice: groqTtsVoice },
  ...(openaiAvailable ? [{ provider: 'openai', model: 'gpt-4o-mini-tts' }] : []),
];

// Profiles for each cloud/local provider
export const groqDefaults: AIProfile | null = groqAvailable ? {
  // STT chain: Groq first (fastest hosted whisper), then OpenAI/Fireworks — a provider
  // account block (billing/region) must degrade to the next whisper, not fail the request.
  stt: [
    { provider: 'groq', model: groqSttModel },
    ...(openaiAvailable ? [{ provider: 'openai' as const, model: 'whisper-1' }] : []),
    ...(fireworksAvailable ? [{ provider: 'fireworks' as const, model: 'whisper-v3' }] : []),
    // Local whisper server (WHISPER_HOST + PROVIDER_CHAIN including ollama) as last resort:
    // survives every cloud account being down — the student still gets transcription.
    ...(ollamaAvailable ? [{ provider: 'ollama' as const, model: 'whisper-large-v3' }] : []),
  ],
  llm: [
    { provider: 'groq', model: groqLlmModel },
    { provider: 'modal-qwen3asr-pipeline', model: 'translategemma-12b' },
  ],
  tts: ttsChain,
  keys: { groq: process.env.GROQ_API_KEY!, ...(openaiAvailable ? { openai: process.env.OPENAI_API_KEY! } : {}) },
  audioFormat: 'wav',  // VoiceDubService expects WAV for AudioStreamBuffer
  language: 'fr',
  maxTokens: 150,
} : null;

export const ollamaDefaults: AIProfile | null = ollamaAvailable ? {
  stt: [{ provider: 'ollama', model: 'whisper-large-v3-turbo' }],
  llm: [{ provider: 'ollama', model: ollamaModel }],
  ...(openaiAvailable ? { tts: [{ provider: 'openai', model: 'gpt-4o-mini-tts' }] } : {}),
  ...(openaiAvailable ? { keys: { openai: process.env.OPENAI_API_KEY! } } : {}),
  language: 'fr',
  maxTokens: 150,
} : null;

// translationDefaults is used by client.pipeline() — gpuEndpoint is dynamically toggled
// Fallback order: Local Qwen3 (fastest) → GPU → Groq (cloud) → Modal Qwen3-ASR (serverless)
export const translationDefaults: AIProfile = {
  gpuEndpoint: RUNPOD_ENDPOINT,
  stt: [
    // Local MLX Qwen3-ASR (Apple Silicon, fastest when available)
    ...(mlxQwenAvailable ? [{ provider: 'mlx-qwen3-asr' as const, model: 'qwen3-asr' }] : []),
    ...(groqAvailable ? [{ provider: 'groq' as const, model: groqSttModel }] : []),
    ...(fireworksAvailable && !groqAvailable ? [{ provider: 'fireworks' as const, model: 'whisper-v3' }] : []),
    { provider: 'modal-qwen3asr-pipeline', model: 'qwen3-asr-1.7b' },
    { provider: 'modal-voxtral', model: 'voxtral-mini-3b' },
  ],
  llm: [
    ...(groqAvailable ? [{ provider: 'groq' as const, model: groqLlmModel }] : []),
    ...(fireworksAvailable ? [{ provider: 'fireworks' as const, model: 'accounts/fireworks/models/llama-v3p3-70b-instruct' }] : []),
    { provider: 'modal-qwen3asr-pipeline', model: 'translategemma-12b' },
  ],
  tts: ttsChain,
  keys: {
    ...(groqAvailable ? { groq: process.env.GROQ_API_KEY! } : {}),
    ...(openaiAvailable ? { openai: process.env.OPENAI_API_KEY! } : {}),
  },
  audioFormat: 'wav',  // VoiceDubService expects WAV for AudioStreamBuffer
  language: 'fr',
  maxTokens: 150,
};

// Backward-compat aliases — renamed in service-centric refactor but still imported by ai-handlers/pipeline-runner
export const groqProfile = groqDefaults;
export const ollamaProfile = ollamaDefaults;
export const translationProfile = translationDefaults;

// ── Intelligence modules ────────────────────────────────────────────────────
export const performanceRanker = new PerformanceRanker();
export const adaptiveTimeout = new AdaptiveTimeoutCalculator();
export const ttfacTracker = new TtfacTracker({ enabled: true, minSamples: 2 });

export const client = createAIClient({
  registry,
  defaultProfile: translationDefaults,
  performanceRanker,
  adaptiveTimeout,
  ttfacTracker,
  diversifyChains: true,
});

// ── GPU Provider Client Instances ────────────────────────────────────────────

export const runpod = new RunpodClient();
export const vast = new VastClient();
/**
 * Vast.ai KVM-mode client. Required for snapshot capture path (CRIU/
 * cuda-checkpoint need CAP_SYS_ADMIN which Vast.ai containers strip).
 * Same API key as `vast`.
 */
export const vastVm = new VastVmClient();
export const tensordock = new TensordockClient();
export const modal = new ModalClient({ defaultFunctionName: 'serve' });
export const scaleway = new ScalewayClient();
export const flyio = new FlyioClient();
export const railway = new RailwayClient();
/** Hyperstack (NexGen Cloud) — H100 VMs with driver 570+ out of the box. */
export const hyperstack = new HyperstackClient();

/**
 * Shared GPU provider registry — one place that documents constructed backends.
 * Mirrors `src/factory.ts`: register backends first, then SnapgpuClient (which
 * looks up SnapgpuBackend = 'vast' | 'runpod' only — hyperstack is not a
 * Snapgpu backend).
 */
export const gpuRegistry = new GpuProviderRegistry();
gpuRegistry.register(runpod);
gpuRegistry.register(vast);
gpuRegistry.register(vastVm);
gpuRegistry.register(tensordock);
gpuRegistry.register(modal);
gpuRegistry.register(hyperstack);

const _snapgpuS3Config: import('../src/gpu-providers/snapgpu-client').SnapgpuS3Config | undefined =
  process.env.SNAPGPU_S3_ENDPOINT
    ? {
        endpoint: process.env.SNAPGPU_S3_ENDPOINT,
        bucket: process.env.SNAPGPU_S3_BUCKET ?? '',
        accessKey: process.env.SNAPGPU_S3_ACCESS_KEY ?? '',
        secretKey: process.env.SNAPGPU_S3_SECRET_KEY ?? '',
        region: process.env.SNAPGPU_S3_REGION,
        keyPrefix: process.env.SNAPGPU_S3_KEY_PREFIX,
      }
    : undefined;
if (_snapgpuS3Config)
  log.log(`S3 persistence: ${_snapgpuS3Config.endpoint}/${_snapgpuS3Config.bucket}`);
else
  log.log("S3 not configured — snapshots won't persist cross-host (add SNAPGPU_S3_ENDPOINT to .env)");
export const snapgpu = new SnapgpuClient({
  registry: gpuRegistry,
  defaultBackend: (process.env.SNAPGPU_DEFAULT_BACKEND as 'vast' | 'runpod') ?? 'vast',
  s3Config: _snapgpuS3Config,
});
gpuRegistry.register(snapgpu);
// CPU compute providers — registry lookup only (not GPU cascade).
gpuRegistry.register(flyio);
gpuRegistry.register(scaleway);
gpuRegistry.register(railway);

// ── Centralized translationDefaults mutator ─────────────────────────────────

/**
 * Apply a partial update to translationDefaults with logging.
 * All mutations to translationDefaults should go through this function
 * for traceability and consistency.
 */
export function updateActivePipeline(patch: Partial<AIProfile>, reason: string): void {
  const changes: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (translationDefaults as any)[key] = value;
      if (key === 'gpuEndpoint') {
        changes.push(`gpuEndpoint=${value || 'undefined'}`);
      } else if (Array.isArray(value)) {
        changes.push(`${key}=[${(value as any[]).map((e: any) => e.provider).join('→')}]`);
      } else if (typeof value === 'object') {
        changes.push(`${key}={...}`);
      } else {
        changes.push(`${key}=${value}`);
      }
    }
  }
  if (changes.length > 0) {
    log.log(`${reason}: ${changes.join(', ')}`);
  }
}

// ── GPU health state mutators (need translationDefaults) ─────────────────────

/** Auto-recovery timer handle — only one pending at a time. */
let gpuRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
/** Auto-recovery probe interval (ms). Probes at 30s, then 60s, then 120s. */
const RECOVERY_INTERVALS_MS = [30_000, 60_000, 120_000];
let recoveryAttempt = 0;

export function markGpuUnhealthy(reason: string): void {
  if (!gpuHealthy) return;
  setGpuHealthy(false);
  updateActivePipeline({ gpuEndpoint: undefined }, `markGpuUnhealthy: ${reason}`);
  setGpuReadyForProduction(false);
  setGpuShadowMode(false);
  resetReadinessCheck();
  latencyRing.length = 0; setLatencyRingIdx(0); // reset latency data on tier change
  log.log(`Unhealthy: ${reason}`);
  broadcastProviderStatus('offline', 'cloud', reason);

  // Schedule auto-recovery probe (if pod endpoint still exists)
  scheduleGpuRecoveryProbe();
}

export function markGpuHealthy(): void {
  if (gpuHealthy) return;
  setGpuHealthy(true);
  latencyRing.length = 0; setLatencyRingIdx(0);
  recoveryAttempt = 0;
  cancelGpuRecoveryProbe();
  const hasWarmthData = gpuModelWarmth.updatedAt > 0;
  // Avoid launching duplicate readiness checks (race condition fix)
  if (isReadinessCheckInProgress()) {
    log.log('Health recovered but readiness check already running — skipping');
  } else if (!hasWarmthData || (isStageWarm('stt') && isStageWarm('llm'))) {
    _startReadinessCheck(deployState.endpoint);
  } else {
    log.log(`Health recovered — STT=${isStageWarm('stt')} LLM=${isStageWarm('llm')}, waiting for warmth`);
    broadcastProviderStatus('booting', 'cloud', 'GPU ready — waiting for model warmup');
  }
}

/** Internal helper: start readiness benchmark for the given endpoint. */
export function _startReadinessCheck(endpoint: string): void {
  void (async () => {
    const shouldRun = await shouldRunGpuReadinessCheck(endpoint);
    if (!shouldRun) {
      log.log('GPU endpoint is not a speech pipeline — skipping STT/LLM/TTS readiness benchmark');
      broadcastProviderStatus('ready', 'gpu', 'GPU app ready — speech readiness benchmark not applicable');
      return;
    }

    broadcastProviderStatus('booting', 'cloud', 'GPU ready — running readiness benchmark');
    await runGpuReadinessCheck(
      endpoint,
      () => markGpuShadowMode(endpoint), // onPass → shadow mode
      (stage, bestMs, targetMs) => markGpuWarmupFailed(stage, bestMs, targetMs), // onFail → repechage
    );
  })().catch(err => log.error('Readiness check error: %s', err instanceof Error ? err.message : err));
}

/** Called when all services pass benchmark → enter shadow mode */
export function markGpuShadowMode(endpoint: string): void {
  // translationDefaults.gpuEndpoint NOT set yet — cloud still serves
  log.log('Shadow mode active — GPU fires in background, cloud serves users');
  broadcastProviderStatus('booting', 'cloud', 'GPU shadow mode — validating in production');
}

/** Called when shadow mode succeeds → activate production */
export function markGpuProductionReady(endpoint: string): void {
  updateActivePipeline({ gpuEndpoint: endpoint }, 'markGpuProductionReady');
  setGpuReadyForProduction(true);
  log.log('Production ready — GPU activated');
  broadcastProviderStatus('ready', 'gpu', 'GPU pipeline active');
}

/** Called when repechage kicks in */
export function markGpuWarmupFailed(stage: string, bestMs: number, targetMs: number): void {
  log.warn(`Readiness FAIL: ${stage} best=${bestMs}ms target=${targetMs}ms — entering repechage`);
  broadcastProviderStatus('booting', 'cloud', `GPU ${stage} latency ${bestMs}ms > target ${targetMs}ms — repechage`);
}

/** Called when repechage attempts exhausted — GPU condemned */
export function markGpuCondemned(): void {
  updateActivePipeline({ gpuEndpoint: undefined }, 'markGpuCondemned');
  setGpuReadyForProduction(false);
  log.error('GPU condemned — repechage exhausted, routing all traffic to cloud');
  broadcastProviderStatus('error', 'cloud', 'GPU condemned — repechage exhausted');
}

function scheduleGpuRecoveryProbe(): void {
  cancelGpuRecoveryProbe();
  if (!deployState.endpoint || deployState.status !== 'ready') return;

  const delayMs = RECOVERY_INTERVALS_MS[Math.min(recoveryAttempt, RECOVERY_INTERVALS_MS.length - 1)];
  log.log(`Recovery probe scheduled in ${delayMs / 1000}s (attempt ${recoveryAttempt + 1})`);

  gpuRecoveryTimer = setTimeout(async () => {
    gpuRecoveryTimer = null;
    if (gpuHealthy) return; // already recovered
    if (!deployState.endpoint || deployState.status !== 'ready') return;

    try {
      const res = await fetch(`${deployState.endpoint}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) {
        log.log('Recovery probe succeeded — marking healthy');
        markGpuHealthy();
        return;
      }
      log.log(`Recovery probe failed: HTTP ${res.status}`);
    } catch (err) {
      log.log(`Recovery probe failed: ${err instanceof Error ? err.message : err}`);
    }

    // Schedule next attempt with backoff
    recoveryAttempt++;
    scheduleGpuRecoveryProbe();
  }, delayMs);
}

function cancelGpuRecoveryProbe(): void {
  if (gpuRecoveryTimer) {
    clearTimeout(gpuRecoveryTimer);
    gpuRecoveryTimer = null;
  }
}

/**
 * Whether GPU should be preferred over cloud for request hedging.
 * Based on availability + latency P95.
 */
export function shouldPreferGpu(): boolean {
  return isGpuAvailable() && isGpuLatencyAcceptable();
}

/**
 * Whether GPU TTS should be used (warm) or cloud TTS should be preferred (cold).
 * When GPU TTS is cold (CUDA graphs not compiled), cloud TTS is faster (~726ms vs ~11s).
 * When GPU TTS is warm, GPU streaming TTFB (~230ms) beats cloud (~726ms).
 */
export function shouldPreferGpuTts(): boolean {
  if (!isGpuAvailable()) return false;
  if (isTtsWarm()) return true;

  // Check saved profile — if we know this exact config warms up fast, race anyway
  const profile = getColdStartProfile(deployState.gpuType, deployState.dockerImage, deployState.provider);
  if (profile && profile.coldTtfbMs < 1000) return true; // cold start < 1s, race it

  return false; // cold GPU TTS is too slow, use cloud
}

// ── Per-stage circuit breakers ──────────────────────────────────────────────
// Track failures per GPU stage. If a stage fails 3x consecutively, skip it
// for 30s (use cloud instead). Unlike markGpuUnhealthy which disables ALL
// GPU stages, this only disables the broken stage.

interface StageBreaker {
  failures: number;
  openUntil: number; // timestamp — breaker is open (skip GPU) until this time
}

const stageBreakers: Record<string, StageBreaker> = {
  stt: { failures: 0, openUntil: 0 },
  llm: { failures: 0, openUntil: 0 },
  tts: { failures: 0, openUntil: 0 },
};

const BREAKER_FAILURE_THRESHOLD = 3;
const BREAKER_RECOVERY_MS = 30_000;

export function recordStageSuccess(stage: 'stt' | 'llm' | 'tts'): void {
  stageBreakers[stage].failures = 0;
  stageBreakers[stage].openUntil = 0;
}

export function recordStageFailure(stage: 'stt' | 'llm' | 'tts'): void {
  const b = stageBreakers[stage];
  b.failures++;
  if (b.failures >= BREAKER_FAILURE_THRESHOLD) {
    b.openUntil = Date.now() + BREAKER_RECOVERY_MS;
    log.warn(`GPU ${stage} circuit OPEN — ${b.failures} consecutive failures, skipping for ${BREAKER_RECOVERY_MS / 1000}s`);
  }
}

export function isStageCircuitClosed(stage: 'stt' | 'llm' | 'tts'): boolean {
  const b = stageBreakers[stage];
  if (b.openUntil === 0) return true;
  if (Date.now() >= b.openUntil) {
    // Recovery timeout elapsed — allow one probe (half-open)
    b.openUntil = 0;
    b.failures = 0;
    log.log(`GPU ${stage} circuit CLOSED (recovery timeout elapsed)`);
    return true;
  }
  return false;
}

export function resetStageBreakers(): void {
  for (const stage of ['stt', 'llm', 'tts']) {
    stageBreakers[stage].failures = 0;
    stageBreakers[stage].openUntil = 0;
  }
}

/** Snapshot of stage circuit breaker state for /health endpoint. */
export interface StageBreakerSnapshot {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure: string | null;
  opensAt: string | null;
}

/** Return a snapshot of all stage circuit breakers for external consumption. */
export function getStageBreakersSnapshot(): Record<string, StageBreakerSnapshot> {
  const result: Record<string, StageBreakerSnapshot> = {};
  const now = Date.now();
  for (const stage of ['stt', 'llm', 'tts'] as const) {
    const b = stageBreakers[stage];
    let state: 'closed' | 'open' | 'half-open';
    if (b.openUntil === 0) {
      state = 'closed';
    } else if (now >= b.openUntil) {
      // Recovery timeout elapsed — effectively half-open (will allow next probe)
      state = 'half-open';
    } else {
      state = 'open';
    }
    result[stage] = {
      state,
      failures: b.failures,
      lastFailure: b.openUntil > 0 ? new Date(b.openUntil - BREAKER_RECOVERY_MS).toISOString() : null,
      opensAt: state === 'open' ? new Date(b.openUntil).toISOString() : null,
    };
  }
  return result;
}

/** Clean up recovery timer on shutdown. */
export function cleanupProviders(): void {
  cancelGpuRecoveryProbe();
}

// ── Runtime reload ──────────────────────────────────────────────────────────

/**
 * Re-evaluate provider availability flags from process.env after API keys change.
 * Rebuilds the providers mapping, registry entries, ttsChain, and translationDefaults keys.
 * Returns which providers were added or removed.
 */
export function reloadProviderAvailability(): { added: string[]; removed: string[] } {
  const prev = {
    groq: groqAvailable,
    openai: openaiAvailable,
    deepgram: deepgramAvailable,
    fireworks: fireworksAvailable,
    openrouter: openrouterAvailable,
    elevenlabs: elevenlabsAvailable,
  };

  // Re-evaluate availability flags from process.env
  groqAvailable = !!process.env.GROQ_API_KEY;
  openaiAvailable = !!process.env.OPENAI_API_KEY;
  deepgramAvailable = !!process.env.DEEPGRAM_API_KEY;
  fireworksAvailable = !!process.env.FIREWORKS_API_KEY;
  openrouterAvailable = !!process.env.OPENROUTER_API_KEY;
  elevenlabsAvailable = !!process.env.ELEVENLABS_API_KEY;

  // Re-evaluate model/voice vars
  groqSttModel = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
  groqLlmModel = process.env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile';
  groqTtsModel = process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english';
  groqTtsVoice = process.env.GROQ_TTS_VOICE || 'autumn';

  // Rebuild providers mapping (clear and repopulate)
  providers.stt = {};
  providers.chat = {};
  providers.chatDynamicRoutes = undefined;
  providers.dynamicModelCatalogs = undefined;

  if (groqAvailable) {
    providers.stt['whisper-large-v3'] = groqSTT;
    providers.stt['whisper-large-v3-turbo'] = groqSTT;
    providers.chat['llama-3.3-70b-versatile'] = groqLLM;
    providers.chat['llama-3.1-8b-instant'] = groqLLM;
  }

  // MLX Qwen3-ASR (unchanged at runtime — local server)
  if (mlxQwenAvailable && mlxQwenProvider) {
    providers.stt['qwen3-asr'] = mlxQwenProvider;
    providers.stt['qwen3-asr-0.6b-4bit'] = mlxQwenProvider;
    providers.stt['qwen3-asr-0.6b'] = mlxQwenProvider;
  }

  // Ollama providers are constructed from ollamaHost (unchanged at runtime)
  if (ollamaAvailable && ollamaLLMProvider && ollamaSTTProvider) {
    providers.stt['whisper-large-v3'] = providers.stt['whisper-large-v3'] || ollamaSTTProvider;
    providers.stt['whisper-large-v3-turbo'] = providers.stt['whisper-large-v3-turbo'] || ollamaSTTProvider;
    providers.chat[ollamaModel] = ollamaLLMProvider;
    providers.chat['llama-3.3-70b-versatile'] = providers.chat['llama-3.3-70b-versatile'] || ollamaLLMProvider;
    providers.chat['llama-3.1-8b-instant'] = providers.chat['llama-3.1-8b-instant'] || ollamaLLMProvider;
  }

  if (openrouterAvailable) {
    enableOpenRouterPassthrough();
  }

  // Rebuild registry entries for providers that changed availability.
  // Note: AIProviderRegistry has no unregister() — re-registering overwrites,
  // and removed providers remain inert (no key = calls will fail gracefully).
  if (groqAvailable) {
    registry.register({
      id: 'groq',
      name: 'Groq',
      description: 'Groq Cloud LPU inference',
      capabilities: ['stt', 'llm', 'tts'],
      requiresApiKey: true,
      stt: groqSTT,
      llm: groqLLM,
      tts: groqTTS,
    });
  }

  // OpenAI registry update (STT + TTS)
  if (openaiAvailable) {
    const existing = registry.getProvider('openai');
    if (existing) {
      existing.stt = openaiSTT;
      if (!existing.capabilities.includes('stt')) existing.capabilities.push('stt');
      if (openaiTTS) {
        existing.tts = openaiTTS;
        if (!existing.capabilities.includes('tts')) existing.capabilities.push('tts');
      }
    } else {
      registry.register({
        id: 'openai',
        name: 'OpenAI',
        description: 'OpenAI API (GPT-4o Transcribe + TTS)',
        capabilities: ['stt', ...(openaiTTS ? ['tts' as const] : [])],
        requiresApiKey: true,
        stt: openaiSTT,
        ...(openaiTTS ? { tts: openaiTTS } : {}),
      });
    }
  }

  // ElevenLabs Scribe STT
  if (elevenlabsAvailable) {
    registry.register({
      id: 'elevenlabs' as ProviderId,
      name: 'ElevenLabs',
      description: 'ElevenLabs Scribe — highest accuracy STT',
      capabilities: ['stt'],
      requiresApiKey: true,
      stt: elevenlabsSTT,
    });
  }

  // Rebuild TTS chain (Modal first — multilingual, free, no API key)
  ttsChain = [
    { provider: 'modal', model: 'qwen3-tts' },
    { provider: 'groq', model: groqTtsModel, voice: groqTtsVoice },
    ...(openaiAvailable ? [{ provider: 'openai', model: 'gpt-4o-mini-tts' }] : []),
  ];

  // Update translationDefaults keys and chains
  updateActivePipeline({
    keys: {
      groq: process.env.GROQ_API_KEY || '',
      ...(openaiAvailable ? { openai: process.env.OPENAI_API_KEY! } : {}),
    },
    stt: [{ provider: 'groq', model: groqSttModel }],
    llm: [
      { provider: 'groq', model: groqLlmModel },
      { provider: 'modal-qwen3asr-pipeline', model: 'translategemma-12b' },
    ],
    tts: ttsChain,
  }, 'reloadProviderAvailability');

  // Track changes
  const added: string[] = [];
  const removed: string[] = [];
  const current: Record<string, boolean> = {
    groq: groqAvailable,
    openai: openaiAvailable,
    deepgram: deepgramAvailable,
    fireworks: fireworksAvailable,
    openrouter: openrouterAvailable,
    elevenlabs: elevenlabsAvailable,
  };
  for (const [name, was] of Object.entries(prev)) {
    const now = current[name];
    if (!was && now) added.push(name);
    if (was && !now) removed.push(name);
  }

  if (added.length || removed.length) {
    log.log(`Reloaded: +${added.join(',') || 'none'} -${removed.join(',') || 'none'}`);
  }

  return { added, removed };
}

// Re-export providers needed by handlers
export { groqSTT, groqLLM, groqTTS, ollamaSTT, ollamaLLM, OllamaLLMProvider, OllamaSTTProvider };
export { openaiSTT, fireworksSTT, deepgramSTT, elevenlabsSTT };
export { fireworksLLM, modalTTS, modalMossTTS, modalSeamlessSTT, modalSeamlessLLM, qwen3asrPipelineSTT, qwen3asrPipelineLLM, modalVoxtralSTT };
export { mlxQwen3AsrSTT, MlxQwen3AsrProvider } from '../src/providers/mlx-qwen3-asr';
export { openrouterQwen3Embedding, openaiEmbedding };
// Re-export state values needed by ai-handlers
export { gpuShadowMode } from './state';
