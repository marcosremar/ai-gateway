import type {
  ChatCompletion, ChatMessage, ChatRequest, ChatStream, SpeechRequest, SpeechResult, TranscribeRequest, Transcription,
} from '../../node/gateway-types';
import type { TelemetryEmitter } from '../telemetry';

export type LocalStage = 'stt' | 'tts' | 'llm';
export type StagePolicy = 'local-first' | 'gateway-first' | 'gateway-only';
export type LocalDevice = 'webgpu' | 'wasm';
export type ServedBy = 'local' | 'gateway';
export type FallbackReason = 'refused' | 'loading' | 'error' | 'timeout' | 'low_confidence' | 'gateway_error';

export interface GatewayLike {
  transcribe(req: TranscribeRequest): Promise<Transcription>;
  chat(req: ChatRequest): Promise<ChatCompletion>;
  chatStream(req: ChatRequest): Promise<ChatStream>;
  speech(req: SpeechRequest): Promise<SpeechResult>;
}

export interface DeviceCapabilities {
  webgpu: boolean;
  shaderF16: boolean;
  gpu: string | null;
  mobile: boolean;
  deviceMemoryGb: number | null;
  storageFreeMb: number | null;
}

export interface Footprint {
  memoryMb: number;
  downloadMb: number;
}

export interface LoadProgress {
  stage: LocalStage;
  model: string;
  device: LocalDevice;
  status: 'loading' | 'ready' | 'error';
  progress: number;
  loadMs?: number;
}

export interface LoadContext {
  device: LocalDevice;
  caps: DeviceCapabilities;
  onProgress(progress: number): void;
}

export interface LocalModel<E> {
  id: string;
  size: Partial<Record<LocalDevice, Footprint>>;
  load(ctx: LoadContext): Promise<E>;
}

export interface SttEngine {
  transcribe(audio: Float32Array, opts: { language?: string; prompt?: string }): Promise<{ text: string; avgLogprob?: number }>;
}

export interface TtsEngine {
  speak(text: string, opts: { voice: string; fallbackVoice?: string; speed?: number }): Promise<{ samples: Float32Array; rate: number }>;
}

export type LlmOptions = Pick<ChatRequest, 'temperature' | 'max_tokens' | 'top_p' | 'stop' | 'seed' | 'response_format'>;

export interface LlmEngine {
  stream(messages: ChatMessage[], opts: LlmOptions, signal: AbortSignal): AsyncIterable<string>;
}

export interface LocalModels {
  stt?: LocalModel<SttEngine>;
  tts?: LocalModel<TtsEngine>;
  llm?: LocalModel<LlmEngine>;
}

export type Admission =
  | { local: true; device: LocalDevice; memoryMb: number; downloadMb: number }
  | { local: false; reason: 'policy' | 'no_model' | 'unsupported' | 'over_budget' | 'storage' };

export interface LocalTierOptions {
  gateway: GatewayLike;
  policy?: Partial<Record<LocalStage, StagePolicy>>;
  models?: LocalModels;
  deadlineMs?: Partial<Record<LocalStage, number>>;
  budgetMb?: number;
  minAvgLogprob?: number;
  telemetry?: Pick<TelemetryEmitter, 'emit'>;
  onProgress?: (progress: LoadProgress) => void;
  probe?: () => Promise<DeviceCapabilities>;
  decodeAudio?: (file: Blob | Uint8Array) => Promise<Float32Array>;
  now?: () => number;
}

export interface Local {
  servedBy: ServedBy;
  reason: FallbackReason | null;
}

export interface LocalAdmission {
  caps: DeviceCapabilities;
  budgetMb: number;
  stages: Record<LocalStage, Admission>;
}

export interface LocalTier {
  admission(): Promise<LocalAdmission>;
  prefetch(stages?: LocalStage[]): Promise<void>;
  transcribe(req: TranscribeRequest): Promise<Transcription & Local>;
  speak(req: SpeechRequest): Promise<SpeechResult & Local>;
  chat(req: ChatRequest): Promise<ChatCompletion & Local>;
  chatStream(req: ChatRequest): Promise<ChatStream & Local>;
}
