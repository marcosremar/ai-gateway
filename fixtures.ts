/**
 * Root test fixtures — reusable mock data for pipeline and integration tests.
 *
 * Fixes: #642 (e2e pipeline test fixtures)
 */

// ── Pipeline result fixture ───────────────────────────────────────────────────

export interface MockPipelineResult {
  transcription: string;
  response: string;
  audio_base64: string;
  content_type: string;
  timing: {
    total_ms: number;
    stt_ms: number;
    llm_ms: number;
    tts_ms: number;
    used_gpu: boolean;
  };
}

export const MOCK_PIPELINE_RESULT: MockPipelineResult = {
  transcription: 'Hello, how are you today?',
  response: 'I am doing well, thank you for asking!',
  audio_base64: Buffer.from('mock-tts-audio').toString('base64'),
  content_type: 'audio/mpeg',
  timing: {
    total_ms: 350,
    stt_ms: 80,
    llm_ms: 150,
    tts_ms: 120,
    used_gpu: false,
  },
};

// ── Sample LLM messages ──────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const SAMPLE_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello, how are you?' },
  { role: 'assistant', content: 'I am doing well, thank you!' },
];
