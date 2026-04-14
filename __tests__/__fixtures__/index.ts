/**
 * Test fixtures — sample data used across test suites.
 *
 * Provides reusable sample payloads for providers, GPU configs,
 * and pipeline inputs to avoid duplication in test files.
 */

// ── Sample Audio Data ───────────────────────────────────────────────────────

/** Minimal valid WAV header (44 bytes) + 1s of silence at 16kHz, 16-bit, mono */
export function createSilentWav(durationMs = 1000, sampleRate = 16000): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2; // 16-bit = 2 bytes
  const bufferSize = 44 + dataSize;
  const buffer = Buffer.alloc(bufferSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(bufferSize - 8, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Rest is silence (zeros)
  return buffer;
}

/** Sample "audio" buffer for STT tests (just needs to be a Buffer) */
export const SAMPLE_AUDIO_BUFFER = createSilentWav(1000);

// ── Sample Provider Responses ───────────────────────────────────────────────

export const MOCK_STT_RESPONSE = {
  text: 'Hello world',
  language: 'en',
  confidence: 0.95,
  latencyMs: 234,
};

export const MOCK_LLM_RESPONSE = {
  content: 'Hello! How can I help you today?',
  role: 'assistant' as const,
  model: 'llama-3.3-70b-versatile',
  usage: {
    prompt_tokens: 12,
    completion_tokens: 10,
    total_tokens: 22,
  },
  latencyMs: 567,
};

export const MOCK_TTS_RESPONSE = {
  audio: Buffer.from('mock-audio-data'),
  contentType: 'audio/wav',
  latencyMs: 345,
};

// ── Sample Pipeline Result ──────────────────────────────────────────────────

export const MOCK_PIPELINE_RESULT = {
  stt: {
    text: 'Bonjour le monde',
    language: 'fr',
    confidence: 0.92,
  },
  chat: {
    content: 'Hello world',
    role: 'assistant' as const,
  },
  tts: {
    audio: Buffer.from('mock-tts-audio'),
    contentType: 'audio/wav',
  },
  timing: {
    stt_ms: 234,
    chat_ms: 567,
    tts_ms: 345,
    total_ms: 1146,
  },
  usedGpu: false,
};

// ── Sample GPU Configs ──────────────────────────────────────────────────────

export const MOCK_GPU_CONFIG = {
  gpuType: 'NVIDIA GeForce RTX 4090',
  dockerImage: 'marcosremar/babelcast-subtitle:latest',
  ports: ['8000/http', '22/tcp'],
};

export const MOCK_GPU_STATUS = {
  status: 'running' as const,
  podId: 'mock-pod-123',
  endpoint: 'https://mock-endpoint.runpod.ai:8000',
  gpuType: 'NVIDIA GeForce RTX 4090',
  gpuHealthy: true,
  idleSec: 120,
};

export const MOCK_GPU_OFFER = {
  gpuType: 'NVIDIA GeForce RTX 4090',
  pricePerHour: 0.44,
  location: 'US',
  verified: true,
};

// ── Sample Messages ─────────────────────────────────────────────────────────

export const SAMPLE_MESSAGES = [
  { role: 'system' as const, content: 'You are a helpful assistant.' },
  { role: 'user' as const, content: 'Hello, how are you?' },
];

export const SAMPLE_TRANSLATION_MESSAGES = [
  { role: 'system' as const, content: 'Translate from French to English.' },
  { role: 'user' as const, content: 'Bonjour le monde' },
];

// ── Sample Config ───────────────────────────────────────────────────────────

export const SAMPLE_PROVIDER_CONFIG = {
  pipelineStt: [{ providerId: 'groq-whisper', model: 'whisper-large-v3', weight: 1.0 }],
  pipelineLlm: [{ providerId: 'groq', model: 'llama-3.3-70b-versatile', weight: 1.0 }],
  pipelineTts: [{ providerId: 'groq-tts', model: 'canopylabs/orpheus-v1-english', weight: 1.0 }],
};

// ── Sample Error Responses ──────────────────────────────────────────────────

export const MOCK_ERROR_RESPONSES = {
  rateLimit: {
    status: 429,
    body: JSON.stringify({ error: 'Rate limit exceeded' }),
  },
  authFailed: {
    status: 401,
    body: JSON.stringify({ error: 'Invalid API key' }),
  },
  serverError: {
    status: 500,
    body: JSON.stringify({ error: 'Internal server error' }),
  },
  creditExhausted: {
    status: 402,
    body: JSON.stringify({ error: 'Credit exhausted' }),
  },
};
