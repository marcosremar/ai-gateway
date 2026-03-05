/**
 * Tests for providers/self-hosted/self-hosted-provider.ts
 * - SelfHostedSTTProvider
 * - SelfHostedTTSProvider
 * - SelfHostedLLMProvider
 */

import { describe, it, expect } from 'vitest';
import {
  SelfHostedSTTProvider,
  SelfHostedTTSProvider,
  SelfHostedLLMProvider,
} from '../src/providers/self-hosted/self-hosted-provider';

describe('SelfHostedSTTProvider', () => {
  it('creates with providerId', () => {
    const provider = new SelfHostedSTTProvider('tensordock');
    expect(provider.providerId).toBe('tensordock');
  });

  it('is not configured without endpoint', () => {
    const provider = new SelfHostedSTTProvider('runpod');
    expect(provider.isConfigured()).toBe(false);
  });

  it('is configured after withEndpoint()', () => {
    const provider = new SelfHostedSTTProvider('runpod');
    const configured = provider.withEndpoint('http://gpu:8000');
    expect(configured.isConfigured()).toBe(true);
  });

  it('withEndpoint returns new instance (immutable)', () => {
    const provider = new SelfHostedSTTProvider('runpod');
    const configured = provider.withEndpoint('http://gpu:8000');
    expect(configured).not.toBe(provider);
    expect(provider.isConfigured()).toBe(false); // original unchanged
    expect(configured.isConfigured()).toBe(true);
  });

  it('strips trailing slashes from endpoint', () => {
    const provider = new SelfHostedSTTProvider('runpod');
    const configured = provider.withEndpoint('http://gpu:8000///');
    expect(configured.isConfigured()).toBe(true);
  });

  it('getModels returns empty array', () => {
    const provider = new SelfHostedSTTProvider('runpod');
    expect(provider.getModels()).toEqual([]);
  });

  it('throws when transcribe called without endpoint', async () => {
    const provider = new SelfHostedSTTProvider('runpod');
    await expect(
      provider.transcribe({ audio: Buffer.from(''), model: 'whisper-1' })
    ).rejects.toThrow('Endpoint not configured');
  });
});

describe('SelfHostedTTSProvider', () => {
  it('creates with providerId', () => {
    const provider = new SelfHostedTTSProvider('tensordock');
    expect(provider.providerId).toBe('tensordock');
  });

  it('is not configured without endpoint', () => {
    const provider = new SelfHostedTTSProvider('runpod');
    expect(provider.isConfigured()).toBe(false);
  });

  it('is configured after withEndpoint()', () => {
    const provider = new SelfHostedTTSProvider('runpod');
    const configured = provider.withEndpoint('http://gpu:8000');
    expect(configured.isConfigured()).toBe(true);
  });

  it('withEndpoint returns new instance (immutable)', () => {
    const provider = new SelfHostedTTSProvider('runpod');
    const configured = provider.withEndpoint('http://gpu:8000');
    expect(configured).not.toBe(provider);
  });

  it('getModels returns empty array', () => {
    const provider = new SelfHostedTTSProvider('runpod');
    expect(provider.getModels()).toEqual([]);
  });

  it('getVoices returns empty array', () => {
    const provider = new SelfHostedTTSProvider('runpod');
    expect(provider.getVoices()).toEqual([]);
  });

  it('throws when synthesize called without endpoint', async () => {
    const provider = new SelfHostedTTSProvider('runpod');
    await expect(
      provider.synthesize({ input: 'Hello', model: 'tts-1', voice: 'alloy' })
    ).rejects.toThrow('Endpoint not configured');
  });

  it('throws when synthesizeStream called without endpoint', async () => {
    const provider = new SelfHostedTTSProvider('runpod');
    await expect(
      provider.synthesizeStream({ input: 'Hello', model: 'tts-1', voice: 'alloy' })
    ).rejects.toThrow('Endpoint not configured');
  });
});

describe('SelfHostedLLMProvider', () => {
  it('creates with providerId', () => {
    const provider = new SelfHostedLLMProvider('tensordock');
    expect(provider.providerId).toBe('tensordock');
  });

  it('is not configured without endpoint', () => {
    const provider = new SelfHostedLLMProvider('runpod');
    expect(provider.isConfigured()).toBe(false);
  });

  it('is configured after withEndpoint()', () => {
    const provider = new SelfHostedLLMProvider('runpod');
    const configured = provider.withEndpoint('http://gpu:8000');
    expect(configured.isConfigured()).toBe(true);
  });

  it('withEndpoint returns new instance (immutable)', () => {
    const provider = new SelfHostedLLMProvider('runpod');
    const configured = provider.withEndpoint('http://gpu:8000');
    expect(configured).not.toBe(provider);
  });

  it('withApiKey returns same instance (no-op)', () => {
    const provider = new SelfHostedLLMProvider('runpod');
    const result = provider.withApiKey('some-key');
    expect(result).toBe(provider);
  });

  it('withConfig with baseURL calls withEndpoint', () => {
    const provider = new SelfHostedLLMProvider('runpod');
    const configured = provider.withConfig({ apiKey: 'ignored', baseURL: 'http://gpu:8000' });
    expect(configured.isConfigured()).toBe(true);
  });

  it('withConfig without baseURL is no-op', () => {
    const provider = new SelfHostedLLMProvider('runpod');
    const result = provider.withConfig({ apiKey: 'key' });
    expect(result.isConfigured()).toBe(false);
  });

  it('throws when chat called without endpoint', async () => {
    const provider = new SelfHostedLLMProvider('runpod');
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'Hello' }], model: '' })
    ).rejects.toThrow('Endpoint not configured');
  });
});
