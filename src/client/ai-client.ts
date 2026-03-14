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
import type { SpendTracker } from '../tracking/spend-tracker';
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
  /** Tracks deployed instances for cleanup. */
  private readonly deployedInstances = new Map<string, { provider: string; credentials: ProviderCredentials }>();

  constructor(options: AIClientOptions) {
    this.registry = options.registry;
    this.gpuRegistry = options.gpuRegistry;
    this.autoscaler = options.autoscaler;
    this.userId = options.userId;
    this.loadAutoscalerConfig = options.loadAutoscalerConfig;
    this.log = options.logger ?? defaultLogger;
    this.spendTracker = options.spendTracker;

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
    const fallbackOpts = this.buildFallbackOptions(profile, 'STT', overrideOptions);

    const t0 = Date.now();
    const { result, usedProvider, usedModel, attempts } = await withProviderFallback(
      chain,
      async (entry) => {
        const provider = this.resolveProvider(id => this.registry.getSTTProvider(id), entry.provider as ProviderId, profile);
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
    const fallbackOpts = this.buildFallbackOptions(profile, 'LLM', overrideOptions);

    const t0 = Date.now();
    const { result, usedProvider, usedModel, attempts } = await withProviderFallback(
      chain,
      async (entry) => {
        const provider = this.resolveProvider(id => this.registry.getLLMProvider(id), entry.provider as ProviderId, profile);
        return provider.chat({
          messages,
          model: entry.model ?? 'gpt-4o',
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
      }).catch(() => {});
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
    const fallbackOpts = this.buildFallbackOptions(profile, 'TTS', overrideOptions);

    const t0 = Date.now();
    const { result, usedProvider, usedModel, attempts } = await withProviderFallback(
      chain,
      async (entry) => {
        const provider = this.resolveProvider(id => this.registry.getTTSProvider(id), entry.provider as ProviderId, profile);
        return provider.synthesize({
          input: text,
          model: entry.model,  // provider uses its own defaultModel if undefined
          voice: profile.voice ?? 'coral',
          responseFormat: profile.audioFormat,
          instructions: profile.voiceInstructions,
        });
      },
      fallbackOpts,
    );

    return {
      audio: result.audio,
      contentType: result.contentType,
      provider: usedProvider,
      model: usedModel,
      fallbackUsed: attempts > 1,
      latencyMs: Date.now() - t0,
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
    const fallbackOpts = this.buildFallbackOptions(profile, 'Image', overrideOptions);

    const t0 = Date.now();
    const { result, usedProvider, usedModel, attempts } = await withProviderFallback(
      chain,
      async (entry) => {
        const provider = this.resolveProvider(id => this.registry.getImageProvider(id), entry.provider as ProviderId, profile);
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
   * Omni audio chat: audio/text in → audio+text out in one call.
   * Uses the omni fallback chain (default: gpt-audio-mini).
   */
  async omniChat(
    input: { audio?: Buffer | Blob; text?: string },
    instructions: string,
    profileOverride?: AIProfile | PresetName,
  ): Promise<OmniResult> {
    const profile = this.resolveEffectiveProfile(profileOverride);
    const { entries: chain, overrideOptions } = this.buildChain(profile, 'omni');
    const fallbackOpts = this.buildFallbackOptions(profile, 'Omni', overrideOptions);

    const t0 = Date.now();
    const { result, usedProvider, usedModel, attempts } = await withProviderFallback(
      chain,
      async (entry) => {
        const provider = this.resolveProvider(id => this.registry.getOmniProvider(id), entry.provider as ProviderId, profile);
        return provider.omniChat({
          audio: input.audio,
          text: input.text,
          model: entry.model ?? 'gpt-audio-mini',
          voice: profile.voice,
          instructions,
          language: profile.language,
          audioFormat: profile.audioFormat === 'wav' || profile.audioFormat === 'mp3' || profile.audioFormat === 'flac' || profile.audioFormat === 'opus'
            ? profile.audioFormat
            : undefined,
        });
      },
      fallbackOpts,
    );

    return {
      text: result.text,
      audio: result.audio,
      audioBase64: result.audioBase64,
      contentType: result.contentType,
      userTranscript: result.userTranscript,
      usage: result.usage,
      provider: usedProvider,
      model: usedModel ?? result.model,
      fallbackUsed: attempts > 1,
      latencyMs: Date.now() - t0,
    };
  }

  /**
   * Create an ephemeral Realtime API session (WebRTC/WebSocket).
   * Returns a client_secret for direct browser → OpenAI connection.
   */
  async createRealtimeSession(
    config: RealtimeSessionConfig,
    profileOverride?: AIProfile | PresetName,
  ): Promise<RealtimeResult> {
    const profile = this.resolveEffectiveProfile(profileOverride);
    const chains = profile.realtime;
    if (!chains || chains.length === 0) {
      throw new Error('[AIClient] No realtime providers configured in profile');
    }

    const entry = chains[0];
    const provider = this.resolveProvider(
      id => this.registry.getRealtimeProvider(id),
      entry.provider as ProviderId,
      profile,
    );

    const session = await provider.createSession({
      ...config,
      model: config.model || entry.model || 'gpt-4o-mini-realtime-preview',
    });

    return {
      clientSecret: session.clientSecret,
      expiresAt: session.expiresAt,
      provider: entry.provider,
      model: config.model || entry.model || 'gpt-4o-mini-realtime-preview',
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

    // Try GPU pipeline first
    const gpuEndpoint = await this.resolveGpuEndpoint(profile);
    if (gpuEndpoint) {
      try {
        const gpuResult = await this.tryGpuPipeline(gpuEndpoint, audio, systemPrompt, history, profile);
        return { ...gpuResult, totalLatencyMs: Date.now() - t0, usedGpu: true };
      } catch (err) {
        this.log.warn('[AIClient] GPU pipeline failed, falling back to cloud per-stage:', err);
      }
    }

    // Cloud per-stage fallback — overlap STT with LLM connection warmup
    // Fire a lightweight /models probe to the LLM provider during STT to warm
    // the TCP/TLS connection (saves ~100-300ms on cold connections).
    const warmupPromise = gpuEndpoint
      ? fetch(`${gpuEndpoint}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => {})
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
    this.log.info(`[AIClient] Deploying GPU instance via ${provider}...`);

    const instance = await client.createInstance(spec, credentials, this.userId);
    this.deployedInstances.set(instance.instanceId, { provider, credentials });

    this.log.info(`[AIClient] Deployed ${instance.instanceId} → ${instance.endpoint} (${instance.gpuType || 'unknown GPU'})`);
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
          this.log.info(`[AIClient] Health [${elapsed}s]: ${data.status} | ${JSON.stringify(data.services || {})}`);
          if (data.status === 'ok') {
            return { healthy: true, elapsedMs: Date.now() - start, services: data.services };
          }
        } else {
          this.log.info(`[AIClient] Health [${elapsed}s]: HTTP ${resp.status}`);
        }
      } catch (e: any) {
        const msg = e.message?.includes('fetch failed') ? 'not reachable yet' : e.message;
        this.log.info(`[AIClient] Health [${elapsed}s]: ${msg}`);
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
    this.log.info(`[AIClient] Destroying instance ${instanceId} via ${prov}...`);
    await client.deleteInstance(instanceId, creds);
    this.deployedInstances.delete(instanceId);
    this.log.info(`[AIClient] Instance ${instanceId} destroyed.`);
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

    // Expand replicas for self-hosted providers: each config with replicas > 1
    // is duplicated in the chain. This gives automatic redundancy via the existing
    // fallback mechanism — if replica 1 fails, replica 2 (same provider) is tried
    // before moving to the next provider. Cloud APIs ignore replicas.
    const entries: FallbackEntry[] = [];
    for (const c of configs) {
      const count = (c.selfHosted && c.alwaysActive) ? Math.max(c.replicas ?? 1, 1) : 1;
      for (let r = 0; r < count; r++) {
        entries.push({ provider: c.provider, model: c.model });
      }
    }
    return { entries };
  }

  private buildFallbackOptions(
    profile: AIProfile,
    logPrefix: string,
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
      ...profile.fallbackOptions,
      ...overrideOptions,
    };
  }

  private resolveProvider<T extends { withApiKey?: (key: string) => T }>(
    getter: (id: ProviderId) => T,
    providerId: ProviderId,
    profile: AIProfile,
  ): T {
    const base = getter(providerId);
    const apiKey = this.resolveKey(providerId, profile);
    if (apiKey && base.withApiKey) return base.withApiKey(apiKey);
    return base;
  }

  private resolveKey(providerId: ProviderId, profile: AIProfile): string | null {
    return resolveApiKey(providerId, profile.keys as Record<string, string> | undefined);
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
    const url = `${endpoint.replace(/\/$/, '')}/v1/speech`;

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
