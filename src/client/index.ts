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
  PipelineResult,
} from './types';
export type { GpuTransport, GpuPipelineResponse, GpuHealthResponse } from './gpu-transport';
export type { PipelineEvent, PipelineStage } from './pipeline-events';

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
