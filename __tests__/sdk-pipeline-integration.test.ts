import { describe, it, expect, beforeAll } from 'vitest';
import { AIClient } from '../src/client/ai-client';
import { AIProviderRegistry } from '../src/providers/registry';
import { OpenAISTTProvider } from '../src/providers/openai/openai-stt';
import { OpenAITTSProvider } from '../src/providers/openai/openai-tts';
import { OpenAICompatLLMProvider } from '../src/providers/openai-compat/openai-compat-llm';
import { loadEnv, checkOpenAIAvailable } from './helpers';

await loadEnv();

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Check actual API availability (catches 429 rate limits, not just key presence)
const hasKeys = OPENAI_KEY ? await checkOpenAIAvailable(OPENAI_KEY) : false;
if (!hasKeys && OPENAI_KEY) {
  console.log('[sdk-pipeline] OpenAI unavailable (rate-limited or invalid) — tests will be skipped');
}

function createRegistry(): AIProviderRegistry {
  const registry = new AIProviderRegistry();
  const llm = new OpenAICompatLLMProvider({
    providerId: 'openai',
    baseURL: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
  });
  registry.register({
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI API',
    capabilities: ['stt', 'tts', 'llm'],
    requiresApiKey: true,
    stt: new OpenAISTTProvider(),
    tts: new OpenAITTSProvider(),
    llm,
  });
  return registry;
}

const OPENAI_LLM_PROFILE = {
  preset: 'llm' as const,
  llm: [{ provider: 'openai', model: 'gpt-4o-mini' }],
  keys: { openai: OPENAI_KEY },
  fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
};

const OPENAI_STT_PROFILE = {
  preset: 'stt' as const,
  stt: [{ provider: 'openai', model: 'gpt-4o-mini-transcribe' }],
  keys: { openai: OPENAI_KEY },
  fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
};

const OPENAI_TTS_PROFILE = {
  preset: 'tts' as const,
  tts: [{ provider: 'openai', model: 'gpt-4o-mini-tts' }],
  keys: { openai: OPENAI_KEY },
  voice: 'nova',
  audioFormat: 'wav' as const,
  fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
};

const OPENAI_VOICE_PROFILE = {
  preset: 'voice' as const,
  stt: [{ provider: 'openai', model: 'gpt-4o-mini-transcribe' }],
  llm: [{ provider: 'openai', model: 'gpt-4o-mini' }],
  tts: [{ provider: 'openai', model: 'gpt-4o-mini-tts' }],
  keys: { openai: OPENAI_KEY },
  voice: 'nova',
  audioFormat: 'wav' as const,
  fallbackOptions: { timeoutMs: 15_000, retriesPerProvider: 0 },
};

describe.skipIf(!hasKeys)('SDK Pipeline Integration (requires OPENAI_API_KEY)', () => {
  let registry: AIProviderRegistry;

  beforeAll(() => {
    registry = createRegistry();
  });

  it('AIClient with LLM profile → chat() works', async () => {
    const client = new AIClient({ registry, defaultProfile: OPENAI_LLM_PROFILE });
    try {
      const result = await client.chat([{ role: 'user', content: 'Say "hello" in one word.' }]);
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.provider).toBe('openai');
      expect(result.latencyMs).toBeGreaterThan(0);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return;
      throw err;
    }
  });

  it('AIClient with STT profile → transcribe() works', async () => {
    const client = new AIClient({ registry, defaultProfile: OPENAI_STT_PROFILE });
    const buf = Buffer.alloc(44 + 8000 * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + 8000 * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(8000 * 2, 40);

    try {
      const result = await client.transcribe(buf);
      expect(result.text).toBeDefined();
      expect(result.provider).toBe('openai');
      expect(result.latencyMs).toBeGreaterThan(0);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return;
      throw err;
    }
  });

  it('AIClient with TTS profile → synthesize() works', async () => {
    const client = new AIClient({ registry, defaultProfile: OPENAI_TTS_PROFILE });
    try {
      const result = await client.synthesize('Hello world');
      expect(result.audio).toBeDefined();
      expect(result.audio.length).toBeGreaterThan(0);
      expect(result.provider).toBe('openai');
      expect(result.latencyMs).toBeGreaterThan(0);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return;
      throw err;
    }
  });

  it('full pipeline: transcribe() + chat() + synthesize() end-to-end', async () => {
    const client = new AIClient({ registry, defaultProfile: OPENAI_VOICE_PROFILE });

    const buf = Buffer.alloc(44 + 8000 * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + 8000 * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(8000 * 2, 40);

    try {
      const result = await client.pipeline(
        buf,
        'You are a helpful assistant. Reply with exactly: "Pipeline works."',
        [{ role: 'user', content: 'test' }],
      );
      expect(result.stt).toBeDefined();
      expect(result.chat).toBeDefined();
      expect(result.chat.content).toBeDefined();
      expect(result.totalLatencyMs).toBeGreaterThan(0);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 429) return;
      throw err;
    }
  });
});
