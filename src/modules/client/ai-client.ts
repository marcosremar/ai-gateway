/**
 * AIClient — Unified client with profile-based routing and automatic failover.
 *
 * Hides the complexity of provider resolution, chain building, API key injection,
 * and fallback orchestration behind a simple profile-driven API.
 */

import type {
  AIClientOptions,
  AIProfile,
  PresetName,
  StageConfig,
  TranscribeResult,
  ChatResult,
  SynthesizeResult,
  ImageResult,
  OmniResult,
  RealtimeResult,
  PipelineResult,
  DeployResult,
  WarmupResult,
  WarmupEntry,
} from './types';
import type { ChatMessage, ProviderId, RealtimeSessionConfig } from '../providers/types';
import type { FallbackEntry, FallbackOptions } from '../providers/fallback';
import type { AIProviderRegistry } from '../providers/registry';
import type { Autoscaler } from '../factory';
import type { Logger } from '../deps';
import type { GpuTransport } from './gpu-transport';
import type { PipelineEvent } from './pipeline-events';
import type { GpuProviderRegistry } from '../gpu-providers/registry';
import type { InstanceSpec, ProviderCredentials } from '../gpu-providers/types';

import { withProviderFallback } from '../providers/fallback';
import { resolveApiKey } from '../providers/chain-builder';
import { resolveProfile, mergeProfiles } from './presets';
import { findChainForStage, resolveDeclarativeChain } from '../providers/declarative-chain';
import { diversifyChain } from '../providers/chain-diversifier';
import type { SpendTracker } from '../tracking/spend-tracker';
import type { BudgetGuard } from '../tracking/budget-guard';
import type { PerformanceRanker } from '../providers/performance-ranker';
import type { AdaptiveTimeoutCalculator } from '../providers/adaptive-timeout';
import type { TtfacTracker } from '../providers/ttfac-tracker';
import { defaultCreditBlockTracker, hashApiKey } from '../providers/credit-block';
import { defaultLogger } from '../logger';

// ---------------------------------------------------------------------------
// AIClient
// ---------------------------------------------------------------------------

export class AIClient {
  private readonly registry: AIProviderRegistry;
  private readonly gpuRegistry?: GpuProviderRegistry;
  private readonly autoscaler?: Autoscaler;
  private readonly userId?: string;
  private readonly defaultProfile: AIProfile;
  private readonly loadAutoscalerConfig?: () => Promise<import('../types').AutoScalerConfig | null>;
  private readonly log: Logger;
  private readonly spendTracker?: SpendTracker;
  private readonly performanceRanker?: PerformanceRanker;
  private readonly adaptiveTimeout?: AdaptiveTimeoutCalculator;
  private readonly ttfacTracker?: TtfacTracker;
  private readonly budgetGuard?: BudgetGuard;
  private readonly dailyLimitUsd: number;
  private readonly diversifyChains: boolean;
  /** Tracks deployed instances for cleanup. */
  private readonly deployedInstances = new Map<string, { provider: string; credentials: ProviderCredentials }>();
  /** Set of endpoints known to be backed by snapgpu-runtime containers.
   *  Used by tryGpuPipeline to decide between /v1/speech and /v1/invoke. */
  private _snapgpuEndpoints?: Set<string>;

  constructor(options: AIClientOptions) {
    this.registry = options.registry;
    this.gpuRegistry = options.gpuRegistry;
    this.autoscaler = options.autoscaler;
    this.userId = options.userId;
    this.loadAutoscalerConfig = options.loadAutoscalerConfig;
    this.log = options.logger ?? defaultLogger;
    this.spendTracker = options.spendTracker;
    this.performanceRanker = options.performanceRanker;
    this.adaptiveTimeout = options.adaptiveTimeout;
    this.ttfacTracker = options.ttfacTracker;
    this.budgetGuard = options.budgetGuard;
    this.dailyLimitUsd = options.dailyLimitUsd ?? 0;
    this.diversifyChains = options.diversifyChains ?? false;

    this.defaultProfile = options.defaultProfile
      ? resolveProfile(options.defaultProfile)
      : resolveProfile('voice');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Warm up all providers marked with `alwaysActive: true` in the default profile.
   *
   * - GPU providers: triggers a boot via the autoscaler or deploy API
   * - Cloud APIs: sends a lightweight request to warm connections/model caches
   *
   * Call this once after creating the client to pre-warm active providers.
   * Returns a summary of what was warmed and any errors encountered.
   */
  async warmup(): Promise<WarmupResult> {
    const profile = this.defaultProfile;
    const results: WarmupEntry[] = [];

    const stages: Array<{ name: string; configs: StageConfig[] | undefined }> = [
      { name: 'stt', configs: profile.stt },
      { name: 'llm', configs: profile.llm },
      { name: 'tts', configs: profile.tts },
      { name: 'image', configs: profile.image },
      { name: 'omni', configs: profile.omni },
    ];

    const warmupTasks: Promise<void>[] = [];

    for (const { name, configs } of stages) {
      if (!configs) continue;
      for (const config of configs) {
        // Only warm up self-hosted providers — cloud APIs are always available
        if (!config.selfHosted || !config.alwaysActive) continue;
        if (!config.endpoint) {
          this.log.warn(`[AIClient] Warmup skipped ${name}:${config.provider} — selfHosted requires endpoint`);
          continue;
        }
        const replicaCount = Math.max(config.replicas ?? 1, 1);
        for (let r = 0; r < replicaCount; r++) {
          const replicaLabel = replicaCount > 1 ? `#${r + 1}` : '';
          warmupTasks.push(
            this.warmupSelfHosted(name, config, replicaLabel)
              .then((entry) => { results.push(entry); })
          );
        }
      }
    }

    // Warm GPU endpoint if profile has gpuEndpoint
    if (profile.gpuEndpoint) {
      warmupTasks.push(
        this.warmupSelfHostedEndpoint(profile.gpuEndpoint, 'gpu')
          .then((entry) => { results.push(entry); })
      );
    }

    await Promise.allSettled(warmupTasks);

    const ok = results.filter((r) => r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'error').length;
    this.log.log(`[AIClient] Warmup complete: ${ok} ok, ${failed} failed`);

    return { entries: results, totalMs: 0 };
  }

  /**
   * Transcribe audio to text using the STT fallback chain.
   */
  async transcribe(
    audio: Buffer | Blob,
    profileOverride?: AIProfile | PresetName,
  ): Promise<TranscribeResult> {
    const profile = this.resolveEffectiveProfile(profileOverride);
    const { entries: chain, overrideOptions } = this.buildChain(profile, 'stt');
    const fallbackOpts = this.buildFallbackOptions(profile, 'STT', 'stt', overrideOptions);

    // Budget guard: check spend and possibly downgrade models
    let effectiveChain = chain;
    if (this.budgetGuard && this.userId && this.dailyLimitUsd > 0) {
      const check = await this.budgetGuard.checkAndDowngrade(this.userId, chain, 'stt', this.dailyLimitUsd);
      effectiveChain = check.chain;
      if (check.downgraded) this.log.warn(check.reason);
    }

    const t0 = Date.now();
    const { result, usedProvider, usedModel, attempts } = await withProviderFallback(
      effectiveChain,
      async (entry) => {
        const provider = await this.resolveProvider(id => this.registry.getSTTProvider(id), entry.provider as ProviderId, profile, entry.endpoint);
        return provider.transcribe({
          audio,
          model: entry.model ?? 'whisper-large-v3-turbo',
          language: profile.language,
          ...(profile.sttPrompt && { prompt: profile.sttPrompt }),
          ...(profile.sttWordTimestamps && { wordTimestamps: true }),
        });
      },
      fallbackOpts,
    );

    return {
      text: result.text,
      language: result.language,
      duration: result.duration,
      words: result.words,
      provider: usedProvider,
      model: usedModel,
      fallbackUsed: attempts > 1,
      latencyMs: Date.now() - t0,
    };
  }

  /**
   * Chat completion using the LLM fallback chain.
   */
  async chat(
    messages: ChatMessage[],
    profileOverride?: AIProfile | PresetName,
  ): Promise<ChatResult> {
    const profile = this.resolveEffectiveProfile(profileOverride);
    const { entries: chain, overrideOptions } = this.buildChain(profile, 'llm');
    const fallbackOpts = this.buildFallbackOptions(profile, 'LLM', 'llm', overrideOptions);

    // Budget guard: check spend and possibly downgrade models
    let effectiveChain = chain;
    if (this.budgetGuard && this.userId && this.dailyLimitUsd > 0) {
      const check = await this.budgetGuard.checkAndDowngrade(this.userId, chain, 'llm', this.dailyLimitUsd);
      effectiveChain = check.chain;
      if (check.downgraded) this.log.warn(check.reason);
    }

    const t0 = Date.now();
    const { result, usedProvider, usedModel, attempts } = await withProviderFallback(
      effectiveChain,
      async (entry) => {
        const provider = await this.resolveProvider(id => this.registry.getLLMProvider(id), entry.provider as ProviderId, profile, entry.endpoint);
        return provider.chat({
          messages,
          model: entry.model ?? '',  // empty string → provider uses its own defaultModel
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          responseFormat: profile.responseFormat,
        });
      },
      fallbackOpts,
    );

    const chatResult = {
      content: result.content,
      usage: result.usage,
      provider: usedProvider,
      model: usedModel ?? result.model,
      fallbackUsed: attempts > 1,
      latencyMs: Date.now() - t0,
    };

    // Record spend if tracker is available
    if (this.spendTracker && result.usage && this.userId) {
      const costUsd = this.spendTracker.estimateCost(
        usedProvider, usedModel ?? 'unknown',
        result.usage.promptTokens, result.usage.completionTokens,
      );
      void this.spendTracker.record({
        userId: this.userId, provider: usedProvider,
        model: usedModel ?? 'unknown', stage: 'llm',
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
        costUsd, timestamp: Date.now(),
      }).catch(e => console.warn('[bench] record failed:', e instanceof Error ? e.message : e));
    }

    return chatResult;
  }

  /**
   * Synthesize text to audio using the TTS fallback chain.
   */
  async synthesize(
    text: string,
    profileOverride?: AIProfile | PresetName,
  ): Promise<SynthesizeResult> {
    const profile = this.resolveEffectiveProfile(profileOverride);
    const { entries: chain, overrideOptions } = this.buildChain(profile, 'tts');
    const fallbackOpts = this.buildFallbackOptions(profile, 'TTS', 'tts', overrideOptions);

    // TTFAC-aware routing: reorder TTS chain by time-to-first-audio-chunk
    let effectiveChain = this.ttfacTracker ? this.ttfacTracker.rankByTtfac(chain) : chain;

    // Budget guard: check spend and possibly downgrade models
    if (this.budgetGuard && this.userId && this.dailyLimitUsd > 0) {
      const check = await this.budgetGuard.checkAndDowngrade(this.userId, effectiveChain, 'tts', this.dailyLimitUsd);
      effectiveChain = check.chain;
      if (check.downgraded) this.log.warn(check.reason);
    }

    const t0 = Date.now();
    const { result, usedProvider, usedModel, attempts } = await withProviderFallback(
      effectiveChain,
      async (entry) => {
        const provider = await this.resolveProvider(id => this.registry.getTTSProvider(id), entry.provider as ProviderId, profile, entry.endpoint);
        return provider.synthesize({
          input: text,
          model: entry.model ?? '',  // provider uses its own defaultModel if undefined
          voice: profile.voice ?? 'nova',
          responseFormat: profile.audioFormat,
          instructions: profile.voiceInstructions,
          referenceAudio: profile.referenceAudio,
          refText: profile.refText,
        });
      },
      fallbackOpts,
    );

    const latencyMs = Date.now() - t0;

    // Record TTFAC sample (for non-streaming, TTFAC ≈ total latency)
    if (this.ttfacTracker) {
      this.ttfacTracker.record(usedProvider, usedModel ?? '*', latencyMs, latencyMs);
    }

    return {
      audio: result.audio,
      contentType: result.contentType,
      provider: usedProvider,
      model: usedModel,
      fallbackUsed: attempts > 1,
      latencyMs,
    };
  }

  /**
   * Generate an image from a text prompt using the image fallback chain.
   */
  async generate(
    prompt: string,
    profileOverride?: AIProfile | PresetName,
  ): Promise<ImageResult> {
    const profile = this.resolveEffectiveProfile(profileOverride);
    const { entries: chain, overrideOptions } = this.buildChain(profile, 'image');
    const fallbackOpts = this.buildFallbackOptions(profile, 'Image', 'image', overrideOptions);

    const t0 = Date.now();
    const { result, usedProvider, usedModel, attempts } = await withProviderFallback(
      chain,
      async (entry) => {
        const provider = await this.resolveProvider(id => this.registry.getImageProvider(id), entry.provider as ProviderId, profile, entry.endpoint);
        return provider.generate({
          prompt,
          model: entry.model,
          width: profile.imageWidth,
          height: profile.imageHeight,
          steps: profile.imageSteps,
        });
      },
      fallbackOpts,
    );

    return {
      image: result.image,
      contentType: result.contentType,
      revisedPrompt: result.revisedPrompt,
      provider: usedProvider,
      model: usedModel,
      fallbackUsed: attempts > 1,
      latencyMs: Date.now() - t0,
    };
  }

  /**
   * @deprecated Use `realtimeSpeech({ audio, text, instructions })` instead.
   */
  async omniChat(
    input: { audio?: Buffer | Blob; text?: string },
    instructions: string,
    profileOverride?: AIProfile | PresetName,
  ): Promise<OmniResult> {
    const profile = this.resolveEffectiveProfile(profileOverride);
    if (!profile.omni || profile.omni.length === 0) {
      throw new Error('No OMNI providers configured');
    }
    const result = await this.realtimeSpeech(
      { audio: input.audio, text: input.text, instructions },
      profileOverride,
    );
    return {
      text: result.responseText ?? '',
      audio: result.responseAudio ?? Buffer.alloc(0),
      audioBase64: result.audioBase64 ?? '',
      contentType: result.responseAudio ? 'audio/wav' : 'text/plain',
      userTranscript: result.userTranscript,
      usage: result.usage as OmniResult['usage'],
      provider: result.provider,
      model: result.model,
      fallbackUsed: (result as any).fallbackUsed ?? false,
      latencyMs: result.latencyMs ?? 0,
    };
  }

  /**
   * @deprecated Use `realtimeSpeech()` instead.
   */
  async createRealtimeSession(
    config: RealtimeSessionConfig,
    profileOverride?: AIProfile | PresetName,
  ): Promise<RealtimeResult> {
    const result = await this.realtimeSpeech(
      { model: config.model, voice: config.voice, instructions: config.instructions, turnDetection: config.turnDetection as Record<string, unknown>, noiseReduction: config.noiseReduction as any },
      profileOverride,
    );
    return {
      clientSecret: result.clientSecret ?? '',
      expiresAt: result.expiresAt ?? 0,
      provider: result.provider,
      model: result.model,
    };
  }

  /**
   * Realtime speech — unified, transport-agnostic.
   *
   * The gateway decides the transport based on input + profile:
   *
   * 1. `input.sdpOffer` provided → **WebRTC** SDP exchange
   * 2. `input.audio` or `input.text` provided + profile has `omni` chain → **Omni** call (audio in → audio+text out)
   * 3. Otherwise → **Session token** (ephemeral key for browser WebRTC/WebSocket)
   *
   * ```ts
   * // WebRTC SDP exchange
   * const r = await client.realtimeSpeech({ sdpOffer });
   *
   * // Omni: audio in → audio+text out (single call)
   * const r = await client.realtimeSpeech({ audio: wavBuffer, instructions: '...' });
   *
   * // Session token for persistent connection
   * const r = await client.realtimeSpeech({ voice: 'ash', instructions: '...' });
   * ```
   */
  async realtimeSpeech(
    input: import('./types').RealtimeSpeechInput,
    profileOverride?: AIProfile | PresetName,
  ): Promise<import('./types').RealtimeSpeechResult> {
    const profile = this.resolveEffectiveProfile(profileOverride);
    const voice = input.voice || profile.voice || 'ash';

    // ── 1. WebRTC: SDP exchange ──
    if (input.sdpOffer) {
      const chains = profile.realtime;
      if (!chains || chains.length === 0) {
        throw new Error('[AIClient] No realtime providers configured in profile');
      }
      const entry = chains[0];
      const model = input.model || entry.model || 'gpt-4o-mini-realtime-preview';
      const provider = await this.resolveProvider(
        id => this.registry.getRealtimeProvider(id),
        entry.provider as ProviderId, profile, entry.endpoint,
      );
      if (!provider.exchangeSdp) {
        throw new Error(`[AIClient] Provider ${entry.provider} does not support WebRTC SDP exchange`);
      }
      const sdpAnswer = await provider.exchangeSdp({ sdpOffer: input.sdpOffer, model, voice });
      return { transport: 'webrtc', sdpAnswer, provider: entry.provider, model, voice };
    }

    // ── 2. Omni: audio/text in → audio+text out ──
    if ((input.audio || input.text) && profile.omni && profile.omni.length > 0) {
      const { entries: chain, overrideOptions } = this.buildChain(profile, 'omni');
      const fallbackOpts = this.buildFallbackOptions(profile, 'Omni', 'omni', overrideOptions);
      const t0 = Date.now();

      const { result, usedProvider, usedModel, attempts } = await withProviderFallback(
        chain,
        async (entry) => {
          const provider = await this.resolveProvider(
            id => this.registry.getOmniProvider(id), entry.provider as ProviderId, profile, entry.endpoint,
          );
          return provider.omniChat({
            audio: input.audio,
            text: input.text,
            model: entry.model ?? 'gpt-audio-mini',
            voice,
            instructions: input.instructions,
            language: profile.language,
            audioFormat: profile.audioFormat === 'wav' || profile.audioFormat === 'mp3' || profile.audioFormat === 'flac' || profile.audioFormat === 'opus'
              ? profile.audioFormat : undefined,
          });
        },
        fallbackOpts,
      );

      return {
        transport: 'omni',
        responseText: result.text,
        responseAudio: result.audio,
        audioBase64: result.audioBase64,
        userTranscript: result.userTranscript,
        usage: result.usage,
        provider: usedProvider,
        model: usedModel ?? result.model ?? '',
        voice,
        latencyMs: Date.now() - t0,
        fallbackUsed: attempts > 1,
      };
    }

    // ── 3. Session token (WebSocket / data-channel) ──
    const chains = profile.realtime;
    if (!chains || chains.length === 0) {
      throw new Error('[AIClient] No realtime providers configured in profile');
    }
    const entry = chains[0];
    const model = input.model || entry.model || 'gpt-4o-mini-realtime-preview';
    const provider = await this.resolveProvider(
      id => this.registry.getRealtimeProvider(id),
      entry.provider as ProviderId, profile, entry.endpoint,
    );
    const session = await provider.createSession({
      model, voice,
      instructions: input.instructions,
      turnDetection: input.turnDetection as RealtimeSessionConfig['turnDetection'],
      ...(input.noiseReduction != null && { noiseReduction: input.noiseReduction as RealtimeSessionConfig['noiseReduction'] }),
    } satisfies RealtimeSessionConfig);

    return {
      transport: 'session',
      clientSecret: session.clientSecret,
      expiresAt: session.expiresAt,
      provider: entry.provider,
      model, voice,
    };
  }

  /**
   * Full pipeline: STT -> LLM -> TTS.
   *
   * If a GPU endpoint is available (from profile or autoscaler), it tries the
   * unified GPU pipeline first. On failure, falls back to cloud per-stage.
   */
  async pipeline(
    audio: Buffer | Blob,
    systemPrompt: string,
    history: ChatMessage[] = [],
    profileOverride?: AIProfile | PresetName,
  ): Promise<PipelineResult> {
    const profile = this.resolveEffectiveProfile(profileOverride);
    const t0 = Date.now();

    // Try unified GPU pipeline first (single pod handles all stages)
    const gpuEndpoint = await this.resolveGpuEndpoint(profile);
    if (gpuEndpoint) {
      try {
        const gpuResult = await this.tryGpuPipeline(gpuEndpoint, audio, systemPrompt, history, profile);
        return { ...gpuResult, totalLatencyMs: Date.now() - t0, usedGpu: true };
      } catch (err) {
        this.log.warn('[AIClient] GPU pipeline failed, trying chain protocol:', err);
      }
    }

    // Try chain protocol: each stage on its own pod, pods talk directly to each other
    // (avoids 2 gateway round-trips when pods are co-located or in the same datacenter)
    const perStage = this.resolvePerStageEndpoints(profile);
    if (perStage) {
      try {
        const chainResult = await this.tryChainPipeline(perStage, audio, systemPrompt, profile);
        return { ...chainResult, totalLatencyMs: Date.now() - t0, usedGpu: true };
      } catch (err) {
        this.log.warn('[AIClient] Chain pipeline failed, falling back to cloud per-stage:', err);
      }
    }

    // ── Try omni first if profile has omni chain (single call: audio → audio+text) ──
    if (profile.omni && profile.omni.length > 0) {
      try {
        this.log.debug?.('[AIClient] Pipeline: trying omni (single-call STT+LLM+TTS)...');
        const omniResult = await this.realtimeSpeech(
          { audio, instructions: systemPrompt, voice: profile.voice },
          profile,
        );
        if (omniResult.transport === 'omni' && omniResult.responseText) {
          return {
            stt: { text: omniResult.userTranscript ?? '', provider: omniResult.provider, model: omniResult.model, fallbackUsed: false, latencyMs: omniResult.latencyMs ?? 0 },
            chat: { content: omniResult.responseText, provider: omniResult.provider, model: omniResult.model, fallbackUsed: false, latencyMs: omniResult.latencyMs ?? 0 },
            tts: { audio: omniResult.responseAudio ?? Buffer.alloc(0), contentType: 'audio/wav', provider: omniResult.provider, model: omniResult.model, fallbackUsed: false, latencyMs: omniResult.latencyMs ?? 0 },
            totalLatencyMs: Date.now() - t0,
            usedGpu: false,
          };
        }
      } catch (err) {
        this.log.warn('[AIClient] Omni pipeline failed, falling back to sequential:', err);
      }
    }

    // Cloud per-stage fallback — overlap STT with LLM connection warmup
    // Fire a lightweight /models probe to the LLM provider during STT to warm
    // the TCP/TLS connection (saves ~100-300ms on cold connections).
    const warmupPromise = gpuEndpoint
      ? fetch(`${gpuEndpoint}/health`, { signal: AbortSignal.timeout(2000) }).catch(e => console.warn('[pipeline] GPU warmup failed:', e instanceof Error ? e.message : e))
      : Promise.resolve();
    const stt = await this.transcribe(audio, profile);
    await warmupPromise; // likely already done by now
    const userMessage = stt.text;

    const allMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ];
    const chat = await this.chat(allMessages, profile);

    // TTS is optional — if no TTS providers are configured, return empty audio
    let tts: SynthesizeResult;
    try {
      tts = await this.synthesize(chat.content, profile);
    } catch (err) {
      this.log.warn('[AIClient] TTS unavailable in cloud fallback, returning text-only:', err);
      tts = {
        audio: Buffer.alloc(0),
        contentType: '',
        provider: 'none',
        fallbackUsed: false,
        latencyMs: 0,
      };
    }

    return {
      stt,
      chat,
      tts,
      totalLatencyMs: Date.now() - t0,
      usedGpu: false,
    };
  }

  /**
   * @deprecated Use `pipeline()` instead. Streaming transports (SSE/WS/WebRTC) are
   * removed from the proxy server. The `pipeline()` method returns a single JSON
   * result with transparent GPU-vs-cloud routing — no event parsing needed.
   *
   * This method is kept for backward compatibility but will be removed in a future version.
   */
  async *pipelineStream(
    audio: Buffer | Blob,
    systemPrompt: string,
    history: ChatMessage[] = [],
    profileOverride?: AIProfile | PresetName,
    options?: { gpuTransport?: GpuTransport },
  ): AsyncGenerator<PipelineEvent> {
    const profile = this.resolveEffectiveProfile(profileOverride);
    const t0 = Date.now();
    const providers: Record<string, string> = {};

    // ── Try GPU transport first ──
    if (options?.gpuTransport) {
      try {
        yield { event: 'stage', data: { stage: 'stt', status: 'start' } };
        const audioBuffer = audio instanceof Buffer
          ? audio
          : Buffer.from(await (audio as Blob).arrayBuffer());

        const gpuResult = await options.gpuTransport.sendAudio(audioBuffer, {
          systemPrompt,
          history,
          language: profile.language,
        });

        // Emit all stages as completed (GPU runs them atomically)
        yield { event: 'stage', data: { stage: 'stt', status: 'complete' } };
        yield { event: 'transcript', data: { text: gpuResult.transcript, provider: 's2s-gpu', latencyMs: gpuResult.timing.stt_ms } };
        providers.stt = 's2s-gpu';

        yield { event: 'stage', data: { stage: 'llm', status: 'start' } };
        yield { event: 'stage', data: { stage: 'llm', status: 'complete' } };
        yield { event: 'response', data: { text: gpuResult.response, provider: 's2s-gpu', latencyMs: gpuResult.timing.llm_ms } };
        providers.llm = 's2s-gpu';

        yield { event: 'stage', data: { stage: 'tts', status: 'start' } };
        yield { event: 'stage', data: { stage: 'tts', status: 'complete' } };
        yield { event: 'audio', data: { base64: gpuResult.audioBase64, contentType: gpuResult.contentType, provider: 's2s-gpu', latencyMs: gpuResult.timing.tts_ms } };
        providers.tts = 's2s-gpu';

        yield { event: 'complete', data: { timing: gpuResult.timing, usedGpu: true, providers } };
        return;
      } catch (err) {
        this.log.warn('[AIClient] GPU transport failed, falling back to cloud per-stage:', err);
        yield { event: 'error', data: { message: 'GPU pipeline failed, falling back to cloud', stage: 'stt', recoverable: true } };
      }
    }

    // ── Try direct GPU endpoint (fetch-based, same as pipeline()) ──
    const gpuEndpoint = await this.resolveGpuEndpoint(profile);
    if (gpuEndpoint) {
      try {
        yield { event: 'stage', data: { stage: 'stt', status: 'start' } };
        const gpuResult = await this.tryGpuPipeline(gpuEndpoint, audio, systemPrompt, history, profile);

        yield { event: 'stage', data: { stage: 'stt', status: 'complete' } };
        yield { event: 'transcript', data: { text: gpuResult.stt.text, provider: 's2s-gpu', latencyMs: gpuResult.stt.latencyMs } };
        providers.stt = 's2s-gpu';

        yield { event: 'stage', data: { stage: 'llm', status: 'start' } };
        yield { event: 'stage', data: { stage: 'llm', status: 'complete' } };
        yield { event: 'response', data: { text: gpuResult.chat.content, provider: 's2s-gpu', latencyMs: gpuResult.chat.latencyMs } };
        providers.llm = 's2s-gpu';

        yield { event: 'stage', data: { stage: 'tts', status: 'start' } };
        yield { event: 'stage', data: { stage: 'tts', status: 'complete' } };
        const audioBase64 = gpuResult.tts.audio instanceof Buffer
          ? gpuResult.tts.audio.toString('base64')
          : Buffer.from(gpuResult.tts.audio).toString('base64');
        yield { event: 'audio', data: { base64: audioBase64, contentType: gpuResult.tts.contentType, provider: 's2s-gpu', latencyMs: gpuResult.tts.latencyMs } };
        providers.tts = 's2s-gpu';

        yield { event: 'complete', data: { timing: { total_ms: Date.now() - t0 }, usedGpu: true, providers } };
        return;
      } catch (err) {
        this.log.warn('[AIClient] GPU pipeline failed, falling back to cloud per-stage:', err);
        yield { event: 'error', data: { message: 'GPU pipeline failed, falling back to cloud', stage: 'stt', recoverable: true } };
      }
    }

    // ── Try omni first (single call: STT+LLM+TTS combined, fastest) ──
    if (profile.omni && profile.omni.length > 0) {
      try {
        yield { event: 'stage', data: { stage: 'stt', status: 'start' } };
        const audioBuffer = audio instanceof Buffer ? audio : Buffer.from(await (audio as Blob).arrayBuffer());
        const omniResult = await this.realtimeSpeech(
          { audio: audioBuffer, instructions: systemPrompt, voice: profile.voice },
          profile,
        );
        if (omniResult.transport === 'omni' && omniResult.responseText) {
          const latency = omniResult.latencyMs ?? (Date.now() - t0);
          yield { event: 'stage', data: { stage: 'stt', status: 'complete' } };
          yield { event: 'transcript', data: { text: omniResult.userTranscript ?? '', provider: omniResult.provider, latencyMs: latency } };
          providers.stt = omniResult.provider;

          yield { event: 'stage', data: { stage: 'llm', status: 'start' } };
          yield { event: 'stage', data: { stage: 'llm', status: 'complete' } };
          yield { event: 'response', data: { text: omniResult.responseText, provider: omniResult.provider, latencyMs: latency } };
          providers.llm = omniResult.provider;

          yield { event: 'stage', data: { stage: 'tts', status: 'start' } };
          yield { event: 'stage', data: { stage: 'tts', status: 'complete' } };
          const audioData = omniResult.responseAudio ?? Buffer.alloc(0);
          const ttsBase64 = audioData instanceof Buffer ? audioData.toString('base64') : Buffer.from(audioData).toString('base64');
          yield { event: 'audio', data: { base64: ttsBase64, contentType: 'audio/wav', provider: omniResult.provider, latencyMs: latency } };
          providers.tts = omniResult.provider;

          yield { event: 'complete', data: {
            timing: { stt_ms: 0, llm_ms: 0, tts_ms: 0, omni_ms: latency, total_ms: Date.now() - t0 },
            usedGpu: false,
            providers,
          } };
          return;
        }
      } catch (err) {
        this.log.warn('[AIClient] Omni pipelineStream failed, falling back to sequential:', err instanceof Error ? err.message : err);
      }
    }

    // ── Cloud per-stage fallback ──
    let currentStage: 'stt' | 'llm' | 'tts' = 'stt';
    try {
      // STT
      currentStage = 'stt';
      yield { event: 'stage', data: { stage: 'stt', status: 'start' } };
      const stt = await this.transcribe(audio, profile);
      yield { event: 'stage', data: { stage: 'stt', status: 'complete' } };
      yield { event: 'transcript', data: { text: stt.text, provider: stt.provider, latencyMs: stt.latencyMs } };
      providers.stt = stt.provider;

      // LLM
      currentStage = 'llm';
      yield { event: 'stage', data: { stage: 'llm', status: 'start' } };
      const allMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: stt.text },
      ];
      const chat = await this.chat(allMessages, profile);
      yield { event: 'stage', data: { stage: 'llm', status: 'complete' } };
      yield { event: 'response', data: { text: chat.content, provider: chat.provider, latencyMs: chat.latencyMs } };
      providers.llm = chat.provider;

      // TTS
      currentStage = 'tts';
      yield { event: 'stage', data: { stage: 'tts', status: 'start' } };
      const tts = await this.synthesize(chat.content, profile);
      yield { event: 'stage', data: { stage: 'tts', status: 'complete' } };
      const ttsBase64 = tts.audio instanceof Buffer
        ? tts.audio.toString('base64')
        : Buffer.from(tts.audio).toString('base64');
      yield { event: 'audio', data: { base64: ttsBase64, contentType: tts.contentType, provider: tts.provider, latencyMs: tts.latencyMs } };
      providers.tts = tts.provider;

      yield { event: 'complete', data: {
        timing: { stt_ms: stt.latencyMs, llm_ms: chat.latencyMs, tts_ms: tts.latencyMs, total_ms: Date.now() - t0 },
        usedGpu: false,
        providers,
      } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`[AIClient] Cloud pipeline failed at ${currentStage} stage:`, message);
      yield { event: 'error', data: { message: `[${currentStage}] ${message}`, stage: currentStage, recoverable: false } };
    }
  }

  // ── GPU Lifecycle ────────────────────────────────────────────────────────

  /**
   * Deploy a GPU instance using the internal provider registry.
   * Returns a DeployResult with instanceId, endpoint, and GPU info.
   * The deployed endpoint is automatically used by subsequent pipeline() calls.
   */
  async deploy(
    provider: string,
    spec: InstanceSpec,
    credentials: ProviderCredentials,
  ): Promise<DeployResult> {
    if (!this.gpuRegistry) {
      throw new Error('[AIClient] No gpuRegistry configured. Pass gpuRegistry in AIClientOptions.');
    }
    const client = this.gpuRegistry.getOrThrow(provider);
    this.log.log(`[AIClient] Deploying GPU instance via ${provider}...`);

    const instance = await client.createInstance(spec, credentials, this.userId);
    this.deployedInstances.set(instance.instanceId, { provider, credentials });

    this.log.log(`[AIClient] Deployed ${instance.instanceId} → ${instance.endpoint} (${instance.gpuType || 'unknown GPU'})`);
    return {
      instanceId: instance.instanceId,
      endpoint: instance.endpoint,
      gpuType: instance.gpuType,
      status: instance.status,
      provider,
    };
  }

  /**
   * Wait for a GPU endpoint to become healthy.
   * Polls GET /health until status is "ok" or maxWaitMs is exceeded.
   */
  async waitForHealth(
    endpoint: string,
    maxWaitMs = 15 * 60 * 1000,
    pollIntervalMs = 15_000,
  ): Promise<{ healthy: boolean; elapsedMs: number; services?: Record<string, string> }> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      try {
        const resp = await fetch(`${endpoint.replace(/\/$/, '')}/health`, {
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const data = await resp.json() as { status?: string; services?: Record<string, string> };
          this.log.log(`[AIClient] Health [${elapsed}s]: ${data.status} | ${JSON.stringify(data.services || {})}`);
          if (data.status === 'ok') {
            return { healthy: true, elapsedMs: Date.now() - start, services: data.services };
          }
        } else {
          this.log.log(`[AIClient] Health [${elapsed}s]: HTTP ${resp.status}`);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error && e.message?.includes('fetch failed') ? 'not reachable yet' : e instanceof Error ? e.message : String(e);
        this.log.log(`[AIClient] Health [${elapsed}s]: ${msg}`);
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    return { healthy: false, elapsedMs: Date.now() - start };
  }

  /**
   * Destroy a previously deployed GPU instance.
   */
  async destroyInstance(
    instanceId: string,
    provider?: string,
    credentials?: ProviderCredentials,
  ): Promise<void> {
    if (!this.gpuRegistry) {
      throw new Error('[AIClient] No gpuRegistry configured.');
    }

    // Use stored deployment info if available
    const stored = this.deployedInstances.get(instanceId);
    const prov = provider ?? stored?.provider;
    const creds = credentials ?? stored?.credentials;
    if (!prov || !creds) {
      throw new Error(`[AIClient] Unknown instance ${instanceId}. Provide provider and credentials.`);
    }

    const client = this.gpuRegistry.getOrThrow(prov);
    this.log.log(`[AIClient] Destroying instance ${instanceId} via ${prov}...`);
    await client.deleteInstance(instanceId, creds);
    this.deployedInstances.delete(instanceId);
    this.log.log(`[AIClient] Instance ${instanceId} destroyed.`);
  }

  /**
   * Launch a GPU workload with intelligent provider selection.
   * Uses price, reliability, and performance data to select the best provider.
   * This is the unified API inspired by SkyPilot's approach.
   */
  async launchGpuWorkload(
    workload: import('../types').WorkloadSpec,
    credentialsMap?: Record<string, ProviderCredentials>,
  ): Promise<DeployResult & { pricePerHour?: number; reliability?: number }> {
    if (!this.gpuRegistry) {
      throw new Error('[AIClient] No gpuRegistry configured. Pass gpuRegistry in AIClientOptions.');
    }

    // Get all available providers
    const providerIds = ['vast', 'runpod', 'tensordock', 'modal'];
    const providerScores: Array<{
      providerId: string;
      score: number;
      pricePerHour: number;
      reliability: number;
      bootTimeSecs: number;
    }> = [];

    // Query each provider for pricing and availability
    for (const providerId of providerIds) {
      const client = this.gpuRegistry.get(providerId);
      if (!client?.listOffers) continue;

      const creds = credentialsMap?.[providerId] ?? await this._getEnvCredentials(providerId);
      if (!creds) continue;

      try {
        const offers = await client.listOffers({
          gpuTypes: workload.accelerator ? [workload.accelerator] : undefined,
          region: workload.preferredRegions?.[0],
          limit: 10,
        }, creds);

        if (offers.length === 0) continue;

        // Filter by constraints
        let eligibleOffers = offers.filter(o => {
          if (workload.maxPricePerHour && o.pricePerHr > workload.maxPricePerHour) return false;
          if (workload.memoryGb && o.vram < workload.memoryGb) return false;
          if (!workload.allowSpot && o.spotPricePerHr && o.spotPricePerHr > 0) {
            // If spot not allowed, prefer on-demand (higher pricePerHr)
          }
          return true;
        });

        if (eligibleOffers.length === 0) continue;

        // Get the best (cheapest) offer
        const bestOffer = eligibleOffers.reduce((best, o) =>
          o.pricePerHr < best.pricePerHr ? o : best, eligibleOffers[0]);

        // Calculate score (0-100)
        const priceScore = Math.max(0, 100 - (bestOffer.pricePerHr / (workload.maxPricePerHour ?? 5)) * 100);
        const reliabilityScore = (bestOffer.reliability ?? 0.5) * 100;
        const bootTimeScore = Math.max(0, 100 - (client.bootTimeSecs / 600) * 100);
        const score = priceScore * 0.4 + reliabilityScore * 0.3 + bootTimeScore * 0.3;

        providerScores.push({
          providerId,
          score,
          pricePerHour: bestOffer.pricePerHr,
          reliability: bestOffer.reliability ?? 0.5,
          bootTimeSecs: client.bootTimeSecs,
        });

        this.log.log(`[AIClient] Provider ${providerId}: $${bestOffer.pricePerHr.toFixed(3)}/hr, reliability=${(bestOffer.reliability ?? 0.5).toFixed(2)}, score=${score.toFixed(1)}`);
      } catch (err) {
        this.log.warn(`[AIClient] Failed to get offers from ${providerId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (providerScores.length === 0) {
      throw new Error('[AIClient] No providers available for the specified workload');
    }

    // Sort by score (highest first)
    providerScores.sort((a, b) => b.score - a.score);

    // Try providers in order of score
    const errors: string[] = [];
    for (const { providerId, pricePerHour, reliability } of providerScores) {
      const client = this.gpuRegistry.getOrThrow(providerId);
      const creds = credentialsMap?.[providerId] ?? await this._getEnvCredentials(providerId);
      if (!creds) continue;

      try {
        const spec: InstanceSpec = {
          gpuTypes: workload.accelerator ? [workload.accelerator] : undefined,
          storageGb: workload.storageGb,
          dockerImage: workload.dockerImage,
          env: workload.env,
          ports: workload.expose,
          region: workload.preferredRegions?.[0],
          interruptible: workload.allowSpot,
        };

        this.log.log(`[AIClient] Launching workload on ${providerId} (score-based selection)...`);
        const instance = await client.createInstance(spec, creds, this.userId);
        this.deployedInstances.set(instance.instanceId, { provider: providerId, credentials: creds });

        this.log.log(`[AIClient] Launched ${instance.instanceId} → ${instance.endpoint} on ${providerId}`);
        return {
          instanceId: instance.instanceId,
          endpoint: instance.endpoint,
          gpuType: instance.gpuType,
          status: instance.status,
          provider: providerId,
          pricePerHour,
          reliability,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${providerId}: ${msg}`);
        this.log.warn(`[AIClient] Failed to launch on ${providerId}: ${msg}`);
      }
    }

    throw new Error(`[AIClient] All providers failed: ${errors.join('; ')}`);
  }

  /**
   * Get credentials from environment variables for a provider.
   */
  private async _getEnvCredentials(providerId: string): Promise<ProviderCredentials | null> {
    switch (providerId) {
      case 'vast':
        return process.env.VAST_API_KEY ? { apiKey: process.env.VAST_API_KEY } : null;
      case 'hyperstack':
        return process.env.HYPERSTACK_API_KEY ? { apiKey: process.env.HYPERSTACK_API_KEY } : null;
      case 'runpod':
        return process.env.RUNPOD_API_KEY ? { apiKey: process.env.RUNPOD_API_KEY } : null;
      case 'tensordock':
        return (process.env.TENSORDOCK_API_TOKEN && process.env.TENSORDOCK_AUTH_ID)
          ? { apiKey: process.env.TENSORDOCK_API_TOKEN, authId: process.env.TENSORDOCK_AUTH_ID }
          : null;
      case 'modal':
        if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) {
          return { apiKey: `${process.env.MODAL_TOKEN_ID}:${process.env.MODAL_TOKEN_SECRET}` };
        }
        return process.env.MODAL_API_KEY ? { apiKey: process.env.MODAL_API_KEY } : null;
      default:
        return null;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private resolveEffectiveProfile(override?: AIProfile | PresetName): AIProfile {
    if (!override) return this.defaultProfile;
    const resolved = resolveProfile(override);
    return mergeProfiles(this.defaultProfile, resolved);
  }

  private buildChain(
    profile: AIProfile,
    stage: 'stt' | 'llm' | 'tts' | 'image' | 'omni',
  ): { entries: FallbackEntry[]; overrideOptions?: Partial<FallbackOptions> } {
    // Check declarative chains first
    const declChain = findChainForStage(profile.fallbackChains, stage);
    if (declChain) {
      const resolved = resolveDeclarativeChain(declChain);
      const overrideOptions = Object.keys(resolved.options).length > 0
        ? resolved.options
        : undefined;
      return { entries: resolved.chain, overrideOptions };
    }

    const configs: StageConfig[] | undefined = profile[stage];
    if (!configs || configs.length === 0) {
      throw new Error(`[AIClient] No ${stage.toUpperCase()} providers configured in profile`);
    }

    const hasGpuEndpoint = !!(profile.gpuEndpoint);
    let entries: FallbackEntry[] = [];
    for (const c of configs) {
      if (c.selfHosted && !c.endpoint && !hasGpuEndpoint) {
        this.log.log(`[AIClient] Skipping self-hosted ${c.provider}/${c.model ?? 'default'} — no GPU endpoint configured`);
        continue;
      }
      const count = (c.selfHosted && c.alwaysActive) ? Math.max(c.replicas ?? 1, 1) : 1;
      for (let r = 0; r < count; r++) {
        entries.push({
          provider: c.provider,
          model: c.model,
          ...(c.endpoint ? { endpoint: c.endpoint } : {}),
        });
      }
    }

    // Auto-diversify: inject backup from a different provider family if chain is mono-provider
    if (this.diversifyChains) {
      const availableProviders = new Set<string>();
      for (const id of this.registry.listProviders()) availableProviders.add(id.id);
      entries = diversifyChain(entries, stage, availableProviders);
    }

    return { entries };
  }

  private buildFallbackOptions(
    profile: AIProfile,
    logPrefix: string,
    stage: string,
    overrideOptions?: Partial<FallbackOptions>,
  ): FallbackOptions {
    // Build apiKeyHashes from profile keys for credit-block tracking
    const apiKeyHashes: Record<string, string> = {};
    const keys = profile.keys as Record<string, string> | undefined;
    if (keys) {
      for (const [provider, key] of Object.entries(keys)) {
        if (key) apiKeyHashes[provider] = hashApiKey(key);
      }
    }

    return {
      logPrefix: `[AIClient:${logPrefix}]`,
      creditBlockTracker: defaultCreditBlockTracker,
      apiKeyHashes,
      // Wire intelligence modules into fallback
      ...(this.performanceRanker && { performanceRanker: this.performanceRanker, stage }),
      ...(this.adaptiveTimeout && { adaptiveTimeout: this.adaptiveTimeout }),
      ...profile.fallbackOptions,
      ...overrideOptions,
    };
  }

  private async resolveProvider<T extends { withApiKey?: (key: string) => T; withEndpoint?: (url: string) => T }>(
    getter: (id: ProviderId) => T,
    providerId: ProviderId,
    profile: AIProfile,
    endpoint?: string,
  ): Promise<T> {
    let base = getter(providerId);
    const profileKeys = profile.keys as Record<string, string> | undefined;
    const apiKey = profileKeys?.[providerId] ?? await resolveApiKey(providerId);
    if (apiKey && base.withApiKey) base = base.withApiKey(apiKey);
    // Per-entry endpoint override; fall back to global gpuEndpoint for gpu provider
    const effectiveEndpoint = endpoint ?? ((providerId as string) === 'gpu' ? profile.gpuEndpoint : undefined);
    if (effectiveEndpoint && base.withEndpoint) base = base.withEndpoint(effectiveEndpoint);
    return base;
  }

  /**
   * Health-check a self-hosted provider endpoint.
   * Probes GET /health (or /v1/models as fallback) to verify the service is running.
   */
  private async warmupSelfHosted(
    stage: string,
    config: StageConfig,
    replicaLabel = '',
  ): Promise<WarmupEntry> {
    const endpoint = config.endpoint!;
    const id = `${stage}:${config.provider}/${config.model ?? 'default'}${replicaLabel}`;
    return this.warmupSelfHostedEndpoint(endpoint, id, stage, config.provider, config.model);
  }

  /**
   * Probe a self-hosted endpoint for health.
   * Tries /health first, then /v1/models as fallback.
   */
  private async warmupSelfHostedEndpoint(
    endpoint: string,
    id: string,
    stage = 'gpu',
    provider = 'self-hosted',
    model?: string,
  ): Promise<WarmupEntry> {
    const t0 = Date.now();
    const base = endpoint.replace(/\/+$/, '');

    // Try /health first, then /v1/models
    const probes = [`${base}/health`, `${base}/v1/models`];

    for (const url of probes) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (resp.ok) {
          const ms = Date.now() - t0;
          this.log.log(`[AIClient] Warmup self-hosted ${id}: ok (${ms}ms)`);
          return { id, stage, provider, model, status: 'ok', latencyMs: ms };
        }
      } catch {
        // try next probe
      }
    }

    const ms = Date.now() - t0;
    const error = `self-hosted endpoint ${base} not reachable`;
    this.log.warn(`[AIClient] Warmup self-hosted ${id}: ${error} (${ms}ms)`);
    return { id, stage, provider, model, status: 'error', latencyMs: ms, error };
  }

  /**
   * Resolve per-stage GPU endpoints from the profile's STT/LLM/TTS chains.
   *
   * When different stages have dedicated GPU pod endpoints (e.g. one pod for
   * STT, another for LLM, a third for TTS), the chain protocol lets them talk
   * directly instead of routing through the gateway. Returns null when there
   * are no per-stage GPU entries with explicit endpoints.
   */
  private resolvePerStageEndpoints(profile: AIProfile): {
    stt: string; llm: string | null; tts: string | null;
  } | null {
    const sttEntry = profile.stt?.find(e => e.provider === 'gpu' && e.endpoint);
    const llmEntry = profile.llm?.find(e => e.provider === 'gpu' && e.endpoint);
    const ttsEntry = profile.tts?.find(e => e.provider === 'gpu' && e.endpoint);

    // Need at least the STT entry with an endpoint to start the chain
    if (!sttEntry?.endpoint) return null;

    return {
      stt: sttEntry.endpoint,
      llm: llmEntry?.endpoint ?? null,
      tts: ttsEntry?.endpoint ?? null,
    };
  }

  /**
   * Run the pipeline using the chain protocol: STT pod receives audio + chain
   * config, forwards transcript directly to LLM pod, which forwards translation
   * directly to TTS pod. Eliminates 2 gateway round-trips.
   */
  private async tryChainPipeline(
    endpoints: { stt: string; llm: string | null; tts: string | null },
    audio: Buffer | Blob,
    systemPrompt: string,
    profile: AIProfile,
  ): Promise<Omit<PipelineResult, 'totalLatencyMs' | 'usedGpu'>> {
    const timeoutMs = (profile.fallbackOptions?.timeoutMs ?? 30_000) + 15_000;
    const sttBase = endpoints.stt.replace(/\/$/, '');

    const audioBuffer = audio instanceof Blob
      ? Buffer.from(await (audio as Blob).arrayBuffer())
      : audio as Buffer;

    const chainConfig = {
      source_lang: profile.language ?? 'fr',
      target_lang: 'en',
      speaker: profile.voice ?? 'Ryan',
      system_prompt: systemPrompt,
      llm_url: endpoints.llm ?? '',
      tts_url: endpoints.tts ?? '',
    };

    this.log.log(
      `[AIClient] Chain pipeline: stt=${sttBase} llm=${endpoints.llm ?? 'local'} tts=${endpoints.tts ?? 'local'}`,
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${sttBase}/v1/chain/pipeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_b64: audioBuffer.toString('base64'),
          chain: chainConfig,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Chain pipeline ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as {
        transcription?: string; response?: string;
        audio_base64?: string; content_type?: string;
        timing?: { stt_ms?: number; llm_ms?: number; tts_ms?: number };
      };

      const timing = data.timing ?? {};
      return {
        stt: { text: data.transcription ?? '', provider: 'chain-gpu', fallbackUsed: false, latencyMs: timing.stt_ms ?? 0 },
        chat: { content: data.response ?? '', provider: 'chain-gpu', fallbackUsed: false, latencyMs: timing.llm_ms ?? 0 },
        tts: {
          audio: data.audio_base64 ? Buffer.from(data.audio_base64, 'base64') : Buffer.alloc(0),
          contentType: data.content_type ?? 'audio/wav',
          provider: 'chain-gpu', fallbackUsed: false, latencyMs: timing.tts_ms ?? 0,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveGpuEndpoint(profile: AIProfile): Promise<string | null> {
    // Explicit override
    if (profile.gpuEndpoint) return profile.gpuEndpoint;

    // From autoscaler
    if (this.autoscaler && this.userId && this.loadAutoscalerConfig) {
      try {
        const config = await this.loadAutoscalerConfig();
        if (config?.enabled) {
          const decision = await this.autoscaler.getAutoScaleDecision(this.userId, config);
          if (decision.route === 's2s' && decision.endpoint) {
            return decision.endpoint;
          }
        }
      } catch (err) {
        this.log.warn('[AIClient] Autoscaler query failed:', err);
      }
    }

    return null;
  }

  private async tryGpuPipeline(
    endpoint: string,
    audio: Buffer | Blob,
    systemPrompt: string,
    history: ChatMessage[],
    profile: AIProfile,
  ): Promise<Omit<PipelineResult, 'totalLatencyMs' | 'usedGpu'>> {
    const timeoutMs = profile.fallbackOptions?.timeoutMs ?? 30_000;
    // SnapGPU containers expose /v1/invoke/{app}/{fn} instead of /v1/speech.
    // The active provider is stored by the gateway in deployState; we detect
    // snapgpu by the endpoint URL containing 'snapgpu' or via an explicit
    // x-snapgpu header (set by the deploy handler). When neither is available,
    // we default to /v1/speech for backward compatibility.
    const isSnapgpu = profile.gpuProvider === 'snapgpu'
      || endpoint.includes('snapgpu')
      || this._snapgpuEndpoints?.has(endpoint);
    const speechPath = isSnapgpu
      ? `/v1/invoke/${profile.snapgpuAppName || 'babelcast'}/speech`
      : '/v1/speech';
    const url = `${endpoint.replace(/\/$/, '')}${speechPath}`;

    const formData = new FormData();
    const audioBlob = audio instanceof Blob ? audio : new Blob([audio as BlobPart]);
    formData.append('audio', audioBlob, 'audio.webm');
    formData.append('system_prompt', systemPrompt);
    if (history.length > 0) formData.append('history', JSON.stringify(history));
    if (profile.language) formData.append('language', profile.language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`GPU pipeline returned ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as {
        transcription?: string;
        response?: string;
        audio_base64?: string;
        content_type?: string;
        timing?: { stt_ms?: number; llm_ms?: number; tts_ms?: number; total_ms?: number };
      };

      const timing = data.timing || {};
      return {
        stt: {
          text: data.transcription ?? '',
          provider: 's2s-gpu',
          fallbackUsed: false,
          latencyMs: timing.stt_ms ?? 0,
        },
        chat: {
          content: data.response ?? '',
          provider: 's2s-gpu',
          fallbackUsed: false,
          latencyMs: timing.llm_ms ?? 0,
        },
        tts: {
          audio: data.audio_base64 ? Buffer.from(data.audio_base64, 'base64') : Buffer.alloc(0),
          contentType: data.content_type ?? 'audio/mp3',
          provider: 's2s-gpu',
          fallbackUsed: false,
          latencyMs: timing.tts_ms ?? 0,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
