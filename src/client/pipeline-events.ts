/**
 * PipelineEvent — SSE events emitted by `pipelineStream()`.
 *
 * Each variant maps 1:1 to a Server-Sent Event type so the API route
 * can forward them as `event: <type>\ndata: <json>\n\n`.
 */

export type PipelineStage = 'stt' | 'llm' | 'tts';

export type PipelineEvent =
  | { event: 'stage'; data: { stage: PipelineStage; status: 'start' | 'complete' } }
  | { event: 'transcript'; data: { text: string; provider: string; latencyMs: number } }
  | { event: 'response'; data: { text: string; provider: string; latencyMs: number } }
  | { event: 'audio'; data: { base64: string; contentType: string; provider: string; latencyMs: number } }
  | { event: 'complete'; data: { timing: Record<string, number>; usedGpu: boolean; providers: Record<string, string> } }
  | { event: 'error'; data: { message: string; stage?: string; recoverable: boolean } };
