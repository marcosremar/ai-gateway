/**
 * AIClient — Profile-based unified client with automatic failover.
 */

export { AIClient } from './ai-client';
export {
  VOICE_PROFILE,
  CHAT_PROFILE,
  STT_PROFILE,
  TTS_PROFILE,
  LLM_PROFILE,
  IMAGE_PROFILE,
  SYSTEM_PROFILE,
  SPEECH_TO_SPEECH_PROFILE,
  resolveProfile,
  mergeProfiles,
} from './presets';
export type {
  AIProfile,
  PresetName,
  StageConfig,
  AIClientOptions,
  TranscribeResult,
  ChatResult,
  SynthesizeResult,
  ImageResult,
  OmniResult,
  RealtimeResult,
  RealtimeSpeechInput,
  RealtimeSpeechResult,
  PipelineResult,
  DeployResult,
  WorkloadLaunchResult,
  WarmupResult,
  WarmupEntry,
} from './types';
export type { GpuTransport, GpuPipelineResponse, GpuHealthResponse } from './gpu-transport';
/** @deprecated Streaming transports removed. Use pipeline() which returns PipelineResult. */
export type { PipelineEvent, PipelineStage } from './pipeline-events';
export { coldStartRace, waitForGpuReady } from './cold-start-racer';
export type { ColdStartRacerConfig, RaceContext, RaceResult } from './cold-start-racer';

// ── Factory ─────────────────────────────────────────────────────────────────

import { AIClient } from './ai-client';
import type { AIClientOptions } from './types';

/**
 * Create an AIClient instance.
 *
 * ```ts
 * const client = createAIClient({ registry, defaultProfile: 'voice' });
 * const stt = await client.transcribe(audioBuffer);
 * ```
 */
export function createAIClient(options: AIClientOptions): AIClient {
  return new AIClient(options);
}
