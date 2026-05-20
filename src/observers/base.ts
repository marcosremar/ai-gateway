/**
 * Observer types + BaseObserver — separate from index.ts to avoid circular
 * imports between index.ts and concrete observer implementations.
 */

export type FrameKind =
  | 'user_speech_start'
  | 'user_speech_end'
  | 'stt_partial'
  | 'stt_final'
  | 'llm_request'
  | 'llm_first_token'
  | 'llm_complete'
  | 'tts_request'
  | 'tts_first_audio'
  | 'tts_complete'
  | 'bot_speech_start'
  | 'bot_speech_end'
  | 'interruption'
  | 'error';

export interface PipelineFrame {
  kind: FrameKind;
  ts: number;
  stage?: string;
  provider?: string;
  meta?: Record<string, unknown>;
}

export interface Observer {
  readonly name: string;
  onFrame(frame: PipelineFrame): void;
}

export abstract class BaseObserver implements Observer {
  abstract readonly name: string;
  abstract onFrame(frame: PipelineFrame): void;
}
