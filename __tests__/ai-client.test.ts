/**
 * Integration tests — AIClient (ai-gateway package, isolated)
 *
 * Real API calls to OpenAI and Groq through the AIClient.
 * Tests: chat, fallback, profile override, synthesize, transcribe, full pipeline.
 *
 * Run: bunx vitest run --config vitest.config.ai-client.mts
 */

import 'dotenv/config';
import { File as NodeFile } from 'node:buffer';
if (!globalThis.File) (globalThis as any).File = NodeFile;

import { describe, it, expect, beforeAll } from 'vitest';
import { AIProviderRegistry } from '../../packages/ai-gateway/src/providers/registry';
import { OpenAISTTProvider } from '../../packages/ai-gateway/src/providers/openai/openai-stt';
import { OpenAITTSProvider } from '../../packages/ai-gateway/src/providers/openai/openai-tts';
import { AIClient } from '../../packages/ai-gateway/src/client/ai-client';
import type { LLMProvider, ChatRequest, ChatResponse } from '../../packages/ai-gateway/src/providers/types';
import OpenAI from 'openai';

// ─── Minimal LLM Providers (no LLMProvider impl in the package yet) ─────────

class OpenAILLMProvider implements LLMProvider {
  readonly providerId = 'openai';
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
  }

  isConfigured() { return !!process.env.OPENAI_API_KEY; }

  withApiKey(apiKey: string): LLMProvider {
    return new OpenAILLMProvider(apiKey);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model || 'gpt-4o-mini',
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      ...(request.responseFormat && { response_format: request.responseFormat }),
    });
    const choice = response.choices[0];
    return {
      content: choice.message.content || '',
      model: response.model,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }
}

class GroqLLMProvider implements LLMProvider {
  readonly providerId = 'groq';
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }

  isConfigured() { return !!process.env.GROQ_API_KEY; }

  withApiKey(apiKey: string): LLMProvider {
    return new GroqLLMProvider(apiKey);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model || 'llama-3.3-70b-versatile',
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    });
    const choice = response.choices[0];
    return {
      content: choice.message.content || '',
      model: response.model,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }
}

// ─── Registry setup ─────────────────────────────────────────────────────────

let registry: AIProviderRegistry;

beforeAll(() => {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required');
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY required');

  registry = new AIProviderRegistry();

  registry.register({
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI API',
    capabilities: ['stt', 'tts', 'llm'],
    requiresApiKey: true,
    stt: new OpenAISTTProvider(),
    tts: new OpenAITTSProvider(),
    llm: new OpenAILLMProvider(),
  });

  registry.register({
    id: 'groq',
    name: 'Groq',
    description: 'Groq API',
    capabilities: ['llm'],
    requiresApiKey: true,
    llm: new GroqLLMProvider(),
  });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('AIClient — real API calls', () => {

  it('chat() with OpenAI gpt-4o-mini', async () => {
    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [{ provider: 'openai', model: 'gpt-4o-mini' }],
        stt: [{ provider: 'openai' }],
        tts: [{ provider: 'openai' }],
      },
    });

    const result = await client.chat([
      { role: 'user', content: 'Responda apenas "ok" sem mais nada.' },
    ]);

    expect(result.content).toBeTruthy();
    expect(result.provider).toBe('openai');
    expect(result.model).toContain('gpt-4o-mini');
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.fallbackUsed).toBe(false);
  }, 15_000);

  it('chat() with Groq llama-3.3-70b', async () => {
    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
        stt: [{ provider: 'openai' }],
        tts: [{ provider: 'openai' }],
      },
    });

    const result = await client.chat([
      { role: 'user', content: 'Responda apenas "ok" sem mais nada.' },
    ]);

    expect(result.content).toBeTruthy();
    expect(result.provider).toBe('groq');
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.fallbackUsed).toBe(false);
  }, 15_000);

  it('transcribe() with fallback: groq STT (no provider) → openai STT', async () => {
    const client = new AIClient({
      registry,
      defaultProfile: {
        stt: [
          { provider: 'groq', model: 'whisper-large-v3-turbo' },
          { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
        ],
        llm: [{ provider: 'openai', model: 'gpt-4o-mini' }],
        tts: [{ provider: 'openai', model: 'gpt-4o-mini-tts' }],
      },
    });

    // Generate audio to transcribe
    const ttsResult = await client.synthesize('Teste de fallback');
    const result = await client.transcribe(ttsResult.audio);

    expect(result.text).toBeTruthy();
    expect(result.provider).toBe('openai');
    expect(result.fallbackUsed).toBe(true);
  }, 20_000);

  it('chat() with per-call profile override (groq default → openai override)', async () => {
    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
        stt: [{ provider: 'openai' }],
        tts: [{ provider: 'openai' }],
      },
    });

    const result = await client.chat(
      [{ role: 'user', content: 'Responda apenas "ok".' }],
      { llm: [{ provider: 'openai', model: 'gpt-4o-mini' }] },
    );

    expect(result.provider).toBe('openai');
  }, 15_000);

  it('synthesize() returns audio buffer', async () => {
    const client = new AIClient({
      registry,
      defaultProfile: {
        tts: [{ provider: 'openai', model: 'gpt-4o-mini-tts' }],
        llm: [{ provider: 'openai' }],
        stt: [{ provider: 'openai' }],
        voice: 'coral',
      },
    });

    const result = await client.synthesize('Olá, tudo bem?');

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(100);
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.provider).toBe('openai');
  }, 15_000);

  it('pipeline() runs STT → LLM → TTS without GPU', async () => {
    // Generate input audio first
    const ttsClient = new AIClient({
      registry,
      defaultProfile: {
        tts: [{ provider: 'openai', model: 'gpt-4o-mini-tts' }],
        llm: [{ provider: 'openai' }],
        stt: [{ provider: 'openai' }],
      },
    });
    const inputAudio = await ttsClient.synthesize('Oi, como vai?');

    // Run pipeline
    const client = new AIClient({
      registry,
      defaultProfile: {
        stt: [{ provider: 'openai', model: 'gpt-4o-mini-transcribe' }],
        llm: [{ provider: 'openai', model: 'gpt-4o-mini' }],
        tts: [{ provider: 'openai', model: 'gpt-4o-mini-tts' }],
      },
    });

    const result = await client.pipeline(
      inputAudio.audio,
      'Você é um professor de português. Responda em uma frase curta.',
      [],
    );

    expect(result.usedGpu).toBe(false);
    expect(result.stt.text).toBeTruthy();
    expect(result.chat.content).toBeTruthy();
    expect(result.tts.audio).toBeInstanceOf(Buffer);
    expect(result.tts.audio.length).toBeGreaterThan(100);
    expect(result.totalLatencyMs).toBeGreaterThan(0);
  }, 30_000);
});
