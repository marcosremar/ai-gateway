/**
 * Test fixtures — reusable sample data for all test suites.
 *
 * Fixes: #601-625 (missing test fixtures), #721-723 (test factories)
 */

// ── Audio Fixtures ───────────────────────────────────────────────────────────

/** Minimal valid WAV header + silence data */
export function createWavBuffer(durationMs = 1000, sampleRate = 16000): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2;
  const bufferSize = 44 + dataSize;
  const buffer = Buffer.alloc(bufferSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(bufferSize - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

export const FIXTURES = {
  // Audio
  SILENT_WAV_1S: createWavBuffer(1000),
  SILENT_WAV_5S: createWavBuffer(5000),
  EMPTY_BUFFER: Buffer.alloc(0),
  TINY_WAV: createWavBuffer(100),

  // Messages
  SYSTEM_MESSAGE: { role: 'system' as const, content: 'You are a helpful assistant.' },
  USER_MESSAGE: { role: 'user' as const, content: 'Hello, how are you?' },
  ASSISTANT_MESSAGE: { role: 'assistant' as const, content: 'Hello! How can I help?' },
  EMPTY_MESSAGES: [] as Array<{ role: string; content: string }>,
  SINGLE_MESSAGE: [{ role: 'user' as const, content: 'Hi' }],

  // Languages
  LANG_EN: 'en',
  LANG_FR: 'fr',
  LANG_ES: 'es',
  LANG_DE: 'de',
  LANG_PT: 'pt',
  INVALID_LANG: 'xx',

  // Models
  MODEL_WHISPER: 'whisper-large-v3',
  MODEL_LLAMA_70B: 'llama-3.3-70b-versatile',
  MODEL_LLAMA_8B: 'llama-3.1-8b-instant',
  INVALID_MODEL: 'nonexistent-model',

  // GPU Types
  GPU_RTX_4090: 'NVIDIA GeForce RTX 4090',
  GPU_RTX_3090: 'NVIDIA GeForce RTX 3090',
  INVALID_GPU: 'NonExistent GPU',

  // API Keys
  VALID_API_KEY: 'sk-test-valid-key-12345',
  INVALID_API_KEY: 'invalid-key',
  EMPTY_API_KEY: '',

  // URLs
  VALID_URL: 'https://example.com',
  INVALID_URL: 'not-a-url',
  MALICIOUS_URL: 'file:///etc/passwd',

  // Config
  DEFAULT_CONFIG: {
    port: 4000,
    hostname: '0.0.0.0',
    rateLimitRpm: 0,
    idleTimeoutMin: 15,
  },

  // Errors
  NETWORK_ERROR: new Error('Network error: Connection refused'),
  TIMEOUT_ERROR: new Error('Operation timed out after 30000ms'),
  AUTH_ERROR: new Error('Invalid API key'),
} as const;

// ── Mock Responses ───────────────────────────────────────────────────────────

export const MOCK_RESPONSES = {
  STT: {
    text: 'Hello world',
    language: 'en',
    confidence: 0.95,
    latencyMs: 234,
  },

  LLM: {
    content: 'Hello! How can I help you today?',
    role: 'assistant' as const,
    model: 'llama-3.3-70b-versatile',
    usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
    latencyMs: 567,
  },

  TTS: {
    audio: Buffer.from('mock-audio-data'),
    contentType: 'audio/wav',
    latencyMs: 345,
  },

  GPU_STATUS: {
    status: 'running' as const,
    podId: 'mock-pod-123',
    endpoint: 'https://mock-endpoint.runpod.ai:8000',
    gpuType: 'NVIDIA GeForce RTX 4090',
    gpuHealthy: true,
    idleSec: 120,
  },

  PIPELINE: {
    transcription: 'Bonjour le monde',
    response: 'Hello world',
    audio_base64: 'mock-base64-audio',
    content_type: 'audio/wav',
    timing: { total_ms: 1234, used_gpu: true },
  },
} as const;

// ── Pipeline Fixtures ────────────────────────────────────────────────────────

export const MOCK_PIPELINE_RESULT = {
  transcription: 'Bonjour le monde',
  response: 'Hello world',
  audio_base64: 'mock-base64-audio',
  content_type: 'audio/wav',
  timing: { total_ms: 1234, used_gpu: true },
};

export const SAMPLE_MESSAGES = [
  { role: 'system' as const, content: 'You are a real-time translator.' },
  { role: 'user' as const, content: 'Hello, translate this.' },
  { role: 'assistant' as const, content: 'Bonjour, traduisez ceci.' },
];

// ── Edge Cases ───────────────────────────────────────────────────────────────

export const EDGE_CASES = {
  // Empty/Null/Undefined
  NULL_VALUE: null,
  UNDEFINED_VALUE: undefined,
  EMPTY_STRING: '',
  WHITESPACE_STRING: '   ',
  ZERO: 0,
  NEGATIVE: -1,
  MAX_INT: Number.MAX_SAFE_INTEGER,
  NAN: NaN,

  // Large payloads
  LARGE_STRING: 'a'.repeat(1_000_000), // 1MB string
  LARGE_ARRAY: Array.from({ length: 10_000 }, (_, i) => i),
  LARGE_OBJECT: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`key${i}`, `value${i}`])),

  // Unicode
  UNICODE_STRING: '🚀 Hello 世界 🌍 مرحبا',
  EMOJI_ONLY: '🎉🎊🎁🎈🎀',
  RTL_STRING: 'مرحبا بالعالم',

  // Injection attempts
  SQL_INJECTION: "'; DROP TABLE users; --",
  XSS_ATTEMPT: '<script>alert("xss")</script>',
  PATH_TRAVERSAL: '../../../etc/passwd',
  COMMAND_INJECTION: '; ls -la',
  GRAPHQL_INJECTION: '{ __schema { types { name } } }',
} as const;

// ── Time Fixtures ────────────────────────────────────────────────────────────

export const TIME_FIXTURES = {
  PAST_DATE: new Date('2020-01-01T00:00:00.000Z'),
  FUTURE_DATE: new Date('2030-01-01T00:00:00.000Z'),
  EPOCH: new Date(0),
  ONE_SECOND_MS: 1_000,
  ONE_MINUTE_MS: 60_000,
  ONE_HOUR_MS: 3_600_000,
  ONE_DAY_MS: 86_400_000,
  LEAP_YEAR: 2024,
  NON_LEAP_YEAR: 2023,
} as const;
