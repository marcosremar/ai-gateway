/**
 * AI Provider System - Base Types & Interfaces
 *
 * Strategy Pattern + Provider Registry.
 * Each provider implements the same interfaces for STT, TTS, LLM, and Realtime.
 */

// ---------------------------------------------------------------------------
// Provider Identification
// ---------------------------------------------------------------------------

export type ProviderId = 'openai' | 'groq' | 'openrouter' | 'fireworks' | 'deepgram' | 'modal' | 'skypilot' | 'vast-serverless' | 'runpod' | 'tensordock' | 'ollama';

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
}

export interface STTResponse {
  text: string;
  language?: string;
  duration?: number;
  words?: Array<{ word: string; start: number; end: number }>;
  raw?: unknown;
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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'text' };
  stream?: boolean;
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
  inputAudioFormat?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  outputAudioFormat?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
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

export interface RealtimeProvider {
  readonly providerId: ProviderId;
  getModels(): ModelInfo[];
  getVoices(): VoiceInfo[];
  createSession(config: RealtimeSessionConfig): Promise<RealtimeSession>;
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
