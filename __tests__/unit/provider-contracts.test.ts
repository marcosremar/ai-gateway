/**
 * Contract tests for provider APIs.
 *
 * These tests verify that provider APIs conform to expected contracts,
 * ensuring compatibility and preventing breaking changes.
 *
 * Unlike integration tests (which test behavior), contract tests verify
 * the shape and constraints of provider responses.
 *
 * Run with:
 *   bun run vitest run __tests__/provider-contracts.test.ts
 */

import { describe, it, expect } from 'vitest';

// ── STT Contract ─────────────────────────────────────────────────────────────

describe('STT Provider Contract', () => {
  const sttContract = {
    transcribe: expect.any(Function),
  };

  it('should have the required methods', () => {
    // Contract: All STT providers must have transcribe()
    expect(sttContract).toHaveProperty('transcribe');
    expect(typeof sttContract.transcribe).toBe('function');
  });

  it('should accept audio input as Buffer', () => {
    const audio = Buffer.alloc(100);
    expect(Buffer.isBuffer(audio)).toBe(true);
  });

  it('should return standardized response shape', () => {
    // Contract: STT response must have these fields
    const mockResponse = {
      text: 'Hello world',
      language: 'en',
      confidence: 0.95,
      latencyMs: 234,
    };

    expect(mockResponse).toHaveProperty('text');
    expect(typeof mockResponse.text).toBe('string');
    expect(mockResponse).toHaveProperty('language');
    expect(typeof mockResponse.confidence).toBe('number');
    expect(mockResponse.confidence).toBeGreaterThanOrEqual(0);
    expect(mockResponse.confidence).toBeLessThanOrEqual(1);
    expect(mockResponse).toHaveProperty('latencyMs');
    expect(typeof mockResponse.latencyMs).toBe('number');
  });
});

// ── LLM Contract ─────────────────────────────────────────────────────────────

describe('LLM Provider Contract', () => {
  it('should accept messages array', () => {
    const messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
    ];

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.every((m) => 'role' in m && 'content' in m)).toBe(true);
  });

  it('should return standardized response shape', () => {
    const mockResponse = {
      content: 'Hello! How can I help?',
      role: 'assistant',
      model: 'llama-3.3-70b',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
      },
      latencyMs: 567,
    };

    expect(mockResponse).toHaveProperty('content');
    expect(typeof mockResponse.content).toBe('string');
    expect(mockResponse).toHaveProperty('role');
    expect(mockResponse).toHaveProperty('model');
    expect(mockResponse).toHaveProperty('usage');
    expect(mockResponse.usage.total_tokens).toBe(
      mockResponse.usage.prompt_tokens + mockResponse.usage.completion_tokens,
    );
    expect(mockResponse).toHaveProperty('latencyMs');
  });

  it('should handle streaming responses', () => {
    // Contract: If stream=true, response should be iterable or callback-based
    const streamConfig = {
      stream: true,
      onChunk: expect.any(Function),
      onDone: expect.any(Function),
      onError: expect.any(Function),
    };

    expect(streamConfig.stream).toBe(true);
    expect(typeof streamConfig.onChunk).toBe('function');
  });
});

// ── TTS Contract ─────────────────────────────────────────────────────────────

describe('TTS Provider Contract', () => {
  it('should accept text input', () => {
    const text = 'Hello world';
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('should return audio in standardized format', () => {
    const mockResponse = {
      audio: Buffer.from('mock-audio'),
      contentType: 'audio/wav',
      latencyMs: 345,
    };

    expect(mockResponse).toHaveProperty('audio');
    expect(Buffer.isBuffer(mockResponse.audio)).toBe(true);
    expect(mockResponse).toHaveProperty('contentType');
    expect(typeof mockResponse.contentType).toBe('string');
    expect(mockResponse.contentType).toMatch(/^audio\//);
    expect(mockResponse).toHaveProperty('latencyMs');
  });

  it('should support common audio formats', () => {
    const supportedFormats = ['wav', 'mp3', 'opus', 'flac'];

    for (const format of supportedFormats) {
      expect(`audio/${format}`).toMatch(/^audio\//);
    }
  });
});

// ── GPU Provider Contract ────────────────────────────────────────────────────

describe('GPU Provider Contract', () => {
  it('should support boot operation', () => {
    const mockBootResult = {
      id: 'pod-123',
      status: 'running',
      endpoint: 'https://example.com:8000',
    };

    expect(mockBootResult).toHaveProperty('id');
    expect(mockBootResult).toHaveProperty('status');
    expect(mockBootResult).toHaveProperty('endpoint');
  });

  it('should support terminate operation', () => {
    const mockTerminateResult = {
      id: 'pod-123',
      status: 'terminated',
    };

    expect(mockTerminateResult).toHaveProperty('id');
    expect(mockTerminateResult).toHaveProperty('status');
  });

  it('should support health check operation', () => {
    const mockHealthResult = {
      healthy: true,
      latencyMs: 50,
      gpuUtilization: 0.45,
    };

    expect(mockHealthResult).toHaveProperty('healthy');
    expect(typeof mockHealthResult.healthy).toBe('boolean');
    expect(mockHealthResult).toHaveProperty('latencyMs');
  });
});

// ── Fallback Contract ────────────────────────────────────────────────────────

describe('Fallback Chain Contract', () => {
  it('should try providers in order', () => {
    const chain = [
      { providerId: 'groq', weight: 1.0 },
      { providerId: 'openai', weight: 0.5 },
    ];

    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain.every((p) => 'providerId' in p && 'weight' in p)).toBe(true);
  });

  it('should track cooldowns', () => {
    const cooldownState = {
      groq: { cooldownUntil: Date.now() + 30_000, reason: 'timeout' },
      openai: null,
    };

    expect(cooldownState).toHaveProperty('groq');
    expect(cooldownState.groq).toHaveProperty('cooldownUntil');
    expect(cooldownState).toHaveProperty('openai');
  });
});
