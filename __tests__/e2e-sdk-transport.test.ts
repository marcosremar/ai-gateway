import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createProxyServer } from '../src/proxy/server';
import type { Server } from 'http';
import type { LLMProvider, TTSProvider, STTProvider } from '../src/providers/types';

class MockLLMProvider implements LLMProvider {
  readonly providerId = 'mock-llm';
  isConfigured() { return true; }
  withApiKey(_key: string) { return this; }
  async chat(_req: any) {
    return {
      content: 'Hello from mock LLM!',
      model: _req.model || 'mock-model',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
}

class MockTTSProvider implements TTSProvider {
  readonly providerId = 'mock-tts';
  isConfigured() { return true; }
  withApiKey(_key: string) { return this; }
  getModels() { return []; }
  getVoices() { return [{ id: 'mock-voice', name: 'Mock Voice' }]; }
  async synthesize(_req: any) {
    const wavHeader = Buffer.alloc(44);
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(1, 22);
    wavHeader.writeUInt32LE(22050, 24);
    wavHeader.writeUInt32LE(44100, 28);
    wavHeader.writeUInt16LE(2, 32);
    wavHeader.writeUInt16LE(16, 34);
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(0, 40);
    return { audio: wavHeader, contentType: 'audio/wav' };
  }
  async synthesizeStream(_req: any) {
    const result = await this.synthesize(_req);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(result.audio));
        controller.close();
      },
    });
    return readable;
  }
}

class MockSTTProvider implements STTProvider {
  readonly providerId = 'mock-stt';
  isConfigured() { return true; }
  withApiKey(_key: string) { return this; }
  getModels() { return []; }
  async transcribe(_req: any) {
    return { text: 'Transcribed mock audio', language: 'en', duration: 0.5 };
  }
}

describe('E2E SDK Transport', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const llmProvider = new MockLLMProvider();
    const ttsProvider = new MockTTSProvider();
    const sttProvider = new MockSTTProvider();

    server = createProxyServer({
      providers: {
        chat: {
          'mock-model': llmProvider,
          'gpt-4': llmProvider,
        },
        tts: {
          'mock-tts-model': ttsProvider,
          'tts-1': ttsProvider,
        },
        stt: {
          'whisper-large-v3': sttProvider,
        },
      },
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    } else {
      throw new Error('Failed to get server address');
    }
  });

  afterAll(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
  }));

  it('GET /v1/models returns model list', async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(5);

    const modelIds = body.data.map((m: any) => m.id);
    expect(modelIds).toContain('mock-model');
    expect(modelIds).toContain('gpt-4');
    expect(modelIds).toContain('mock-tts-model');
    expect(modelIds).toContain('tts-1');
    expect(modelIds).toContain('whisper-large-v3');
  });

  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('POST /v1/chat/completions returns response', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('mock-model');
    expect(body.choices).toBeDefined();
    expect(body.choices[0].message.content).toBe('Hello from mock LLM!');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage).toBeDefined();
  });

  it('POST /v1/audio/speech returns audio', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-tts-model',
        input: 'Hello world',
        voice: 'mock-voice',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');

    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.length).toBeGreaterThanOrEqual(44);
    expect(buffer.toString('ascii', 0, 4)).toBe('RIFF');
  });

  it('invalid model returns 404', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nonexistent-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error.message).toContain('nonexistent-model');
  });

  it('missing messages returns 400', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
      }),
    });

    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.message).toContain('messages');
  });

  it('missing model returns 400', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.message).toContain('model');
  });

  it('TTS missing voice returns 400', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-tts-model',
        input: 'Hello',
      }),
    });

    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.message).toContain('voice');
  });

  it('unknown route returns 404', async () => {
    const res = await fetch(`${baseUrl}/v1/unknown`);

    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error.message).toContain('not found');
  });

  it('CORS headers are present', async () => {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Origin: 'http://localhost:3000' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const res = await fetch(`${baseUrl}/v1/models`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('E2E SDK Transport — Auth middleware', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const llmProvider = new MockLLMProvider();

    server = createProxyServer({
      apiKeys: ['valid-api-key-123', 'another-key-456'],
      providers: {
        chat: {
          'mock-auth-model': llmProvider,
        },
      },
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    } else {
      throw new Error('Failed to get server address');
    }
  });

  afterAll(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
  }));

  it('rejects request without auth header', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-auth-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(401);
  });

  it('rejects request with invalid API key', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-key',
      },
      body: JSON.stringify({
        model: 'mock-auth-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(401);
  });

  it('accepts request with valid API key', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-api-key-123',
      },
      body: JSON.stringify({
        model: 'mock-auth-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(200);
  });

  it('accepts second configured API key', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer another-key-456',
      },
      body: JSON.stringify({
        model: 'mock-auth-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(200);
  });
});
