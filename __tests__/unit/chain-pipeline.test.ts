/**
 * Integration tests — pod-to-pod chain protocol
 *
 * Spins up lightweight mock HTTP servers to simulate STT/LLM/TTS pods, then
 * exercises AIClient.pipeline() → tryChainPipeline() and the resolve logic.
 *
 * Does NOT require real API keys or GPU pods.
 *
 * Run:  cd ai-gateway && bun test __tests__/chain-pipeline.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { AIClient } from '../../src/client/ai-client';
import { AIProviderRegistry } from '../../src/providers/registry';
import type { AIProfile } from '../../src/client/types';
import type {
  LLMProvider, ChatRequest, ChatResponse,
  STTProvider, STTRequest, STTResponse, ModelInfo,
  TTSProvider, TTSRequest, TTSResponse,
} from '../../src/providers/types';

// ── Minimal mock providers (cloud fallback, never used when chain succeeds) ──

class MockSTT implements STTProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly providerId: any = 'mock-stt';
  calls = 0;
  isConfigured() { return true; }
  getModels(): ModelInfo[] { return []; }
  async transcribe(_r: STTRequest): Promise<STTResponse> {
    this.calls++;
    return { text: 'cloud-stt-fallback' };
  }
}

class MockLLM implements LLMProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly providerId: any = 'mock-llm';
  calls = 0;
  isConfigured() { return true; }
  withApiKey() { return this; }
  async chat(_r: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    return { content: 'cloud-llm-fallback', model: 'mock' };
  }
}

class MockTTS implements TTSProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly providerId: any = 'mock-tts';
  calls = 0;
  isConfigured() { return true; }
  getModels(): ModelInfo[] { return []; }
  async synthesize(_r: TTSRequest): Promise<TTSResponse> {
    this.calls++;
    return { audio: Buffer.from('cloud-tts-fallback'), contentType: 'audio/wav' };
  }
  getVoices(): import('../src/providers/types').VoiceInfo[] { return []; }
  synthesizeStream(_r: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    return Promise.resolve(new ReadableStream());
  }
}

// ── Mock pod HTTP server helpers ─────────────────────────────────────────────

type Handler = (body: any) => any;

function makePodServer(routes: Record<string, Handler>): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      req.on('end', () => {
        const handler = routes[req.url ?? ''];
        if (!handler) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        try {
          const body = raw ? JSON.parse(raw) : {};
          const result = handler(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

// ── Fixture: minimal silent WAV buffer ───────────────────────────────────────

function silentWav(sampleRate = 16000, durationMs = 100): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  return buf;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('resolvePerStageEndpoints', () => {
  const registry = new AIProviderRegistry();
  registry.register({
    id: 'gpu', name: 'GPU', description: '', capabilities: ['stt', 'llm', 'tts'],
    requiresApiKey: false,
    stt: new MockSTT(), llm: new MockLLM(), tts: new MockTTS(),
  });
  const client = new AIClient({ registry });

  it('returns null when no gpu entries have explicit endpoints', () => {
    const profile: AIProfile = {
      stt: [{ provider: 'gpu' }],
      llm: [{ provider: 'gpu' }],
      tts: [{ provider: 'gpu' }],
    };
    // Access private via cast
    const result = (client as any).resolvePerStageEndpoints(profile);
    expect(result).toBeNull();
  });

  it('returns endpoints when STT gpu entry has endpoint', () => {
    const profile: AIProfile = {
      stt: [{ provider: 'gpu', endpoint: 'http://stt-pod:8000' }],
      llm: [{ provider: 'gpu', endpoint: 'http://llm-pod:8000' }],
      tts: [{ provider: 'gpu', endpoint: 'http://tts-pod:8000' }],
    };
    const result = (client as any).resolvePerStageEndpoints(profile);
    expect(result).toEqual({
      stt: 'http://stt-pod:8000',
      llm: 'http://llm-pod:8000',
      tts: 'http://tts-pod:8000',
    });
  });

  it('returns null if stt has no endpoint even if llm/tts do', () => {
    const profile: AIProfile = {
      stt: [{ provider: 'groq' }],
      llm: [{ provider: 'gpu', endpoint: 'http://llm-pod:8000' }],
      tts: [{ provider: 'gpu', endpoint: 'http://tts-pod:8000' }],
    };
    const result = (client as any).resolvePerStageEndpoints(profile);
    expect(result).toBeNull();
  });

  it('returns null llm/tts when only stt has endpoint', () => {
    const profile: AIProfile = {
      stt: [{ provider: 'gpu', endpoint: 'http://stt-pod:8000' }],
      llm: [{ provider: 'groq' }],
      tts: [{ provider: 'groq' }],
    };
    const result = (client as any).resolvePerStageEndpoints(profile);
    expect(result).toEqual({ stt: 'http://stt-pod:8000', llm: null, tts: null });
  });
});

describe('tryChainPipeline — full 3-pod chain', () => {
  let sttServer: { server: Server; url: string };
  let llmServer: { server: Server; url: string };
  let ttsServer: { server: Server; url: string };
  const sttCalls: any[] = [];
  const llmCalls: any[] = [];
  const ttsCalls: any[] = [];

  beforeAll(async () => {
    // TTS pod — terminal node
    ttsServer = await makePodServer({
      '/v1/chain/tts': (body) => {
        ttsCalls.push(body);
        return {
          audio_base64: Buffer.from('tts-audio').toString('base64'),
          content_type: 'audio/wav',
          timing: { tts_ms: 42 },
        };
      },
    });

    // LLM pod — forwards to TTS pod
    llmServer = await makePodServer({
      '/v1/chain/llm': (body) => {
        llmCalls.push(body);
        // Simulate: translate + forward to TTS
        const translated = 'translated text';
        const ttsResult = {
          audio_base64: Buffer.from('tts-audio').toString('base64'),
          content_type: 'audio/wav',
          timing: { tts_ms: 42 },
        };
        return { response: translated, ...ttsResult, timing: { llm_ms: 15, tts_ms: 42 } };
      },
    });

    // STT pod — receives audio + chain config, forwards to LLM pod
    sttServer = await makePodServer({
      '/v1/chain/pipeline': (body) => {
        sttCalls.push(body);
        const transcript = 'hello world';
        // In real pod: would call llmServer, but mock just returns full result
        return {
          transcription: transcript,
          response: 'translated text',
          audio_base64: Buffer.from('tts-audio').toString('base64'),
          content_type: 'audio/wav',
          timing: { stt_ms: 80, llm_ms: 15, tts_ms: 42 },
        };
      },
    });
  });

  afterAll(async () => {
    await Promise.all([
      stopServer(sttServer.server),
      stopServer(llmServer.server),
      stopServer(ttsServer.server),
    ]);
  });

  it('calls STT pod /v1/chain/pipeline with audio_b64 and chain config', async () => {
    const registry = new AIProviderRegistry();
    registry.register({
      id: 'gpu', name: 'GPU', description: '', capabilities: ['stt', 'llm', 'tts'],
      requiresApiKey: false,
      stt: new MockSTT(), llm: new MockLLM(), tts: new MockTTS(),
    });
    const client = new AIClient({ registry });

    const audio = silentWav();
    const result = await (client as any).tryChainPipeline(
      { stt: sttServer.url, llm: llmServer.url, tts: ttsServer.url },
      audio,
      'Translate this',
      { language: 'fr' },
    );

    expect(sttCalls).toHaveLength(1);
    expect(sttCalls[0]).toMatchObject({
      audio_b64: expect.any(String),
      chain: expect.objectContaining({
        source_lang: 'fr',
        llm_url: llmServer.url,
        tts_url: ttsServer.url,
      }),
    });

    expect(result.stt.text).toBe('hello world');
    expect(result.chat.content).toBe('translated text');
    expect(result.tts.audio.length).toBeGreaterThan(0);
    expect(result.stt.provider).toBe('chain-gpu');
  });

  it('returns timing from all stages', async () => {
    const registry = new AIProviderRegistry();
    registry.register({
      id: 'gpu', name: 'GPU', description: '', capabilities: ['stt', 'llm', 'tts'],
      requiresApiKey: false, stt: new MockSTT(), llm: new MockLLM(), tts: new MockTTS(),
    });
    const client = new AIClient({ registry });

    const result = await (client as any).tryChainPipeline(
      { stt: sttServer.url, llm: null, tts: null },
      silentWav(), 'test', {},
    );

    expect(result.stt.latencyMs).toBe(80);
    expect(result.chat.latencyMs).toBe(15);
    expect(result.tts.latencyMs).toBe(42);
  });
});

describe('tryChainPipeline — error handling', () => {
  it('throws when STT pod returns non-200', async () => {
    const { server, url } = await makePodServer({
      '/v1/chain/pipeline': () => { throw new Error('intentional failure'); },
    });

    const registry = new AIProviderRegistry();
    registry.register({
      id: 'gpu', name: 'GPU', description: '', capabilities: ['stt'],
      requiresApiKey: false, stt: new MockSTT(), llm: new MockLLM(), tts: new MockTTS(),
    });
    const client = new AIClient({ registry });

    await expect(
      (client as any).tryChainPipeline({ stt: url, llm: null, tts: null }, silentWav(), '', {}),
    ).rejects.toThrow();

    await stopServer(server);
  });

  it('throws when STT pod is unreachable', async () => {
    const registry = new AIProviderRegistry();
    registry.register({
      id: 'gpu', name: 'GPU', description: '', capabilities: ['stt'],
      requiresApiKey: false, stt: new MockSTT(), llm: new MockLLM(), tts: new MockTTS(),
    });
    const client = new AIClient({ registry });

    await expect(
      (client as any).tryChainPipeline(
        { stt: 'http://127.0.0.1:1', llm: null, tts: null },
        silentWav(), '', {},
      ),
    ).rejects.toThrow();
  });
});

describe('pipeline() — chain selected when per-stage endpoints present', () => {
  let sttServer: { server: Server; url: string };
  let chainCalled = false;

  beforeAll(async () => {
    sttServer = await makePodServer({
      '/v1/chain/pipeline': (_body) => {
        chainCalled = true;
        return {
          transcription: 'chain-stt',
          response: 'chain-llm',
          audio_base64: Buffer.from('chain-tts').toString('base64'),
          content_type: 'audio/wav',
          timing: { stt_ms: 10, llm_ms: 5, tts_ms: 8 },
        };
      },
    });
  });

  afterAll(() => stopServer(sttServer.server));

  it('uses chain protocol and returns usedGpu=true', async () => {
    const mockStt = new MockSTT();
    const mockLlm = new MockLLM();
    const mockTts = new MockTTS();

    const registry = new AIProviderRegistry();
    registry.register({
      id: 'mock-stt', name: 'MockSTT', description: '', capabilities: ['stt'],
      requiresApiKey: false, stt: mockStt,
    });
    registry.register({
      id: 'mock-llm', name: 'MockLLM', description: '', capabilities: ['llm'],
      requiresApiKey: false, llm: mockLlm,
    });
    registry.register({
      id: 'mock-tts', name: 'MockTTS', description: '', capabilities: ['tts'],
      requiresApiKey: false, tts: mockTts,
    });

    const profile: AIProfile = {
      stt: [{ provider: 'gpu', endpoint: sttServer.url }, { provider: 'mock-stt' }],
      llm: [{ provider: 'mock-llm' }],
      tts: [{ provider: 'mock-tts' }],
      language: 'fr',
    };

    const client = new AIClient({ registry, defaultProfile: profile });
    chainCalled = false;

    const result = await client.pipeline(silentWav(), 'translate');

    expect(chainCalled).toBe(true);
    expect(result.usedGpu).toBe(true);
    expect(result.stt.text).toBe('chain-stt');
    expect(result.chat.content).toBe('chain-llm');
    // Cloud providers should NOT have been called
    expect(mockStt.calls).toBe(0);
    expect(mockLlm.calls).toBe(0);
    expect(mockTts.calls).toBe(0);
  });
});
