/**
 * @deprecated PipelineEvent is part of the legacy streaming API (pipelineStream).
 * Use `pipeline()` instead, which returns a single `PipelineResult` JSON object.
 * Streaming transports (SSE/WS/WebRTC) are blocked at the proxy level.
 */

export type PipelineStage = 'stt' | 'llm' | 'tts';

export type PipelineEvent =
  | { event: 'stage'; data: { stage: PipelineStage; status: 'start' | 'complete' } }
  | { event: 'transcript'; data: { text: string; provider: string; latencyMs: number } }
  | { event: 'response'; data: { text: string; provider: string; latencyMs: number } }
  | { event: 'audio'; data: { base64: string; contentType: string; provider: string; latencyMs: number } }
  | { event: 'complete'; data: { timing: Record<string, number>; usedGpu: boolean; providers: Record<string, string> } }
  | { event: 'error'; data: { message: string; stage?: string; recoverable: boolean } };
