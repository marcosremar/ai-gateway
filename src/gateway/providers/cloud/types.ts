/**
 * AI Provider System - Base Types & Interfaces
 *
 * Strategy Pattern + Provider Registry.
 * Each provider implements the same interfaces for STT, TTS, LLM, and Realtime.
 */

// ---------------------------------------------------------------------------
// Provider Identification
// ---------------------------------------------------------------------------

export type ProviderId = 'openai' | 'groq' | 'openrouter' | 'fireworks' | 'fal' | 'zai' | 'deepgram' | 'elevenlabs' | 'minimax' | 'modal' | 'modal-moss' | 'modal-seamless' | 'modal-qwen3asr-pipeline' | 'modal-voxtral' | 'skypilot' | 'vast-serverless' | 'runpod' | 'tensordock' | 'ollama' | 'mlx-qwen3-asr' | 'self-hosted' | 'gpu' | 'mock-stt' | 'mock-llm' | 'mock-tts';

/** @deprecated Use ProviderId instead */
export type AIProviderId = ProviderId;

export type ProviderCapability = 'stt' | 'tts' | 'llm' | 'realtime' | 'image' | 'omni' | 'embedding' | 'rerank';

// ---------------------------------------------------------------------------
// Model Metadata
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  capability: ProviderCapability;
  isDefault?: boolean;
  isDeprecated?: boolean;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// STT (Speech-to-Text)
// ---------------------------------------------------------------------------

export interface STTRequest {
  audio: Buffer | Blob;
  model: string;
  language?: string;
  prompt?: string;
  responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  temperature?: number;
  wordTimestamps?: boolean;
  signal?: AbortSignal;
  /**
   * Deepgram `smart_format` — rewrites numbers/dates/etc. Opt-in (#369):
   * smart formatting can break downstream glossary/term matching, so it is no
   * longer forced on. Omit/false to keep the raw transcript.
   */
  smartFormat?: boolean;
  /**
   * Endpointing / VAD configuration. Provider-native turn detection knobs.
   * Currently honored by Deepgram; other STT providers ignore unknown
   * fields. Tune for your conversation style.
   */
  vad?: {
    /** Deepgram `endpointing` ms — silence required before utterance ends.
     *  Default 10ms (snappy); 200-500ms for natural conversations. */
    endpointingMs?: number;
    /** Deepgram `vad_events=true` to receive SpeechStarted events. */
    vadEvents?: boolean;
    /** Deepgram `utterance_end_ms` — fire UtteranceEnd after N ms silence
     *  even without final transcript. */
    utteranceEndMs?: number;
    /** Deepgram `interim_results` — partial transcripts as user speaks. */
    interimResults?: boolean;
  };
}

/** Per-segment metadata returned by Whisper (verbose_json). */
export interface STTSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
}

export interface STTResponse {
  text: string;
  language?: string;
  duration?: number;
  words?: Array<{ word: string; start: number; end: number }>;
  /** Per-segment Whisper metadata (available when verbose_json is used). */
  segments?: STTSegment[];
  /** Aggregate confidence metrics (averages across all segments). */
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
  raw?: unknown;
  /** Network latency breakdown. total_ms = network_ms + server_ms (when server_ms is available). */
  timing?: {
    total_ms: number;      // full round-trip (client-measured)
    server_ms?: number;    // server-side processing (from processing_ms in response body)
    network_ms?: number;   // total_ms - server_ms
  };
}

export interface STTProvider {
  readonly providerId: ProviderId;
  getModels(): ModelInfo[];
  transcribe(request: STTRequest): Promise<STTResponse>;
  isConfigured(): boolean;
  withApiKey?(apiKey: string): STTProvider;
}

// ---------------------------------------------------------------------------
// TTS (Text-to-Speech)
// ---------------------------------------------------------------------------

export type TTSAudioFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

export interface TTSRequest {
  input: string;
  model: string;
  voice: string;
  responseFormat?: TTSAudioFormat;
  speed?: number;
  instructions?: string;
  referenceAudio?: string;
  refText?: string;  // transcription of reference audio (required for Qwen3-TTS Base cloning)
}

export interface TTSResponse {
  audio: Buffer;
  contentType: string;
  raw?: unknown;
}

export interface VoiceInfo {
  id: string;
  name: string;
  description?: string;
  supportedModels?: string[];
}

export interface TTSProvider {
  readonly providerId: ProviderId;
  getModels(): ModelInfo[];
  getVoices(): VoiceInfo[];
  synthesize(request: TTSRequest): Promise<TTSResponse>;
  synthesizeStream(request: TTSRequest): Promise<ReadableStream<Uint8Array>>;
  isConfigured(): boolean;
  withApiKey?(apiKey: string): TTSProvider;
}

// ---------------------------------------------------------------------------
// LLM (Chat Completion) — NEW
// ---------------------------------------------------------------------------

/** Content part for multimodal messages (vision, etc.). */
export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'text' };
  stream?: boolean;
  timeoutMs?: number;
  /**
   * Output-affecting parameters that the OpenAI-compatible proxy parses but
   * historically dropped before reaching the provider. Passing them through
   * lets tool-calling, nucleus sampling, deterministic seeds, multiple
   * choices, stop sequences, and penalties actually work.
   */
  /** Tool / function definitions (OpenAI tools schema). */
  tools?: unknown[];
  /** Tool choice directive ('auto' | 'none' | 'required' | {type,function}). */
  toolChoice?: unknown;
  /** Nucleus sampling cutoff. */
  topP?: number;
  /** Deterministic sampling seed (honored by some providers). */
  seed?: number;
  /** Number of completions to generate. */
  n?: number;
  /** Stop sequence(s). */
  stop?: string | string[];
  /** Frequency penalty (-2.0 to 2.0). */
  frequencyPenalty?: number;
  /** Presence penalty (-2.0 to 2.0). */
  presencePenalty?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  raw?: unknown;
}

export interface LLMProvider {
  readonly providerId: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Streaming chat — yields content tokens as they arrive. Optional; not all providers support it. */
  chatStream?(request: ChatRequest): AsyncGenerator<string, void, undefined>;
  isConfigured(): boolean;
  withApiKey?(apiKey: string): LLMProvider;
  withConfig?(opts: { apiKey: string; baseURL?: string }): LLMProvider;
}

// ---------------------------------------------------------------------------
// Realtime (Speech-to-Speech)
// ---------------------------------------------------------------------------

export type RealtimeTransport = 'webrtc' | 'websocket';

export interface RealtimeSessionConfig {
  model: string;
  voice?: string;
  instructions?: string;
  inputAudioFormat?: 'audio/pcm' | 'audio/pcmu' | 'audio/pcma' | 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  outputAudioFormat?: 'audio/pcm' | 'audio/pcmu' | 'audio/pcma' | 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  turnDetection?: {
    type: 'server_vad' | 'semantic_vad';
    threshold?: number;
    silenceDurationMs?: number;
    prefixPaddingMs?: number;
  };
  noiseReduction?: { type: 'near_field' | 'far_field' };
}

export interface RealtimeSession {
  clientSecret: string;
  expiresAt: number;
  config: RealtimeSessionConfig;
}

export interface RealtimeSdpConfig {
  /** SDP offer from the browser (text/plain, starts with "v=0"). */
  sdpOffer: string;
  model?: string;
  voice?: string;
}

export interface RealtimeProvider {
  readonly providerId: ProviderId;
  getModels(): ModelInfo[];
  getVoices(): VoiceInfo[];
  createSession(config: RealtimeSessionConfig): Promise<RealtimeSession>;
  /** SDP proxy flow: exchange SDP offer for SDP answer server-side. */
  exchangeSdp?(config: RealtimeSdpConfig): Promise<string>;
  isConfigured(): boolean;
  withApiKey?(apiKey: string): RealtimeProvider;
}

// ---------------------------------------------------------------------------
// Omni Audio (audio-in → audio+text-out in one call)
// ---------------------------------------------------------------------------

export interface OmniRequest {
  audio?: Buffer | Blob;
  text?: string;
  model: string;
  voice?: string;
  instructions?: string;
  language?: string;
  audioFormat?: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16';
  history?: ChatMessage[];
}

export interface OmniResponse {
  text: string;
  audio: Buffer;
  audioBase64: string;
  contentType: string;
  userTranscript?: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface OmniProvider {
  readonly providerId: ProviderId;
  getModels(): ModelInfo[];
  omniChat(request: OmniRequest): Promise<OmniResponse>;
  isConfigured(): boolean;
  withApiKey?(apiKey: string): OmniProvider;
}

// ---------------------------------------------------------------------------
// Image Generation
// ---------------------------------------------------------------------------

export interface ImageRequest {
  prompt: string;
  model?: string;
  width?: number;
  height?: number;
  /** Number of inference steps (for diffusion models) */
  steps?: number;
  /** Random seed for reproducibility */
  seed?: number;
  /** Number of images to generate */
  n?: number;
  /** Base image URL for inpainting / image-to-image */
  imageUrl?: string;
  /** Mask URL for inpainting (white = fill, black = keep) */
  maskUrl?: string;
}

export interface ImageResponse {
  /** Raw image bytes (JPEG/PNG/WebP) */
  image: Buffer;
  contentType: string;
  /** Revised prompt (when the provider rewrites it) */
  revisedPrompt?: string;
  raw?: unknown;
}

export interface ImageProvider {
  readonly providerId: ProviderId;
  generate(request: ImageRequest): Promise<ImageResponse>;
  isConfigured(): boolean;
  withApiKey?(apiKey: string): ImageProvider;
}

// ---------------------------------------------------------------------------
// Provider Descriptor
// ---------------------------------------------------------------------------

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  description: string;
  capabilities: ProviderCapability[];
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  stt?: STTProvider;
  tts?: TTSProvider;
  llm?: LLMProvider;
  realtime?: RealtimeProvider;
  image?: ImageProvider;
  omni?: OmniProvider;
  /**
   * Optional explicit model catalog for capabilities whose provider interface
   * has no `getModels()` (notably LLM). When present, `getAllModels('llm')`
   * enumerates these instead of collapsing the provider to a single pseudo-model
   * (#398), so `/v1/models` reports every available LLM, not one entry per
   * provider id.
   */
  llmModels?: ModelInfo[];
}

// ---------------------------------------------------------------------------
// Provider Configuration (stored in user settings)
// ---------------------------------------------------------------------------

export interface AIProviderSettings {
  activeProvider: ProviderId;
  endpoint?: string;
  keys: Partial<Record<ProviderId, string>>;
  extra?: Record<string, unknown>;
}
