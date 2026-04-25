import { describe, it, expect } from 'vitest';
import {
  SelfHostedSTTProvider,
  SelfHostedTTSProvider,
  SelfHostedLLMProvider,
} from '../../src/providers/self-hosted/self-hosted-provider';

describe('SelfHostedSTTProvider', () => {
  it('isConfigured returns false without endpoint', () => {
    const p = new SelfHostedSTTProvider('runpod');
    expect(p.isConfigured()).toBe(false);
  });

  it('isConfigured returns true after withEndpoint', () => {
    const p = new SelfHostedSTTProvider('runpod').withEndpoint('http://gpu:8000');
    expect(p.isConfigured()).toBe(true);
  });

  it('withEndpoint strips trailing slashes', () => {
    const p = new SelfHostedSTTProvider('runpod').withEndpoint('http://gpu:8000///');
    expect(p.isConfigured()).toBe(true);
  });
});

describe('SelfHostedTTSProvider', () => {
  it('isConfigured returns false without endpoint', () => {
    const p = new SelfHostedTTSProvider('runpod');
    expect(p.isConfigured()).toBe(false);
  });

  it('isConfigured returns true after withEndpoint', () => {
    const p = new SelfHostedTTSProvider('runpod').withEndpoint('http://gpu:8000');
    expect(p.isConfigured()).toBe(true);
  });

  it('withEndpoint strips trailing slashes', () => {
    const p = new SelfHostedTTSProvider('runpod').withEndpoint('http://gpu:8000///');
    expect(p.isConfigured()).toBe(true);
  });
});

describe('SelfHostedLLMProvider', () => {
  it('isConfigured returns false without endpoint', () => {
    const p = new SelfHostedLLMProvider('runpod');
    expect(p.isConfigured()).toBe(false);
  });

  it('isConfigured returns true after withEndpoint', () => {
    const p = new SelfHostedLLMProvider('runpod').withEndpoint('http://gpu:8000');
    expect(p.isConfigured()).toBe(true);
  });

  it('withEndpoint strips trailing slashes', () => {
    const p = new SelfHostedLLMProvider('runpod').withEndpoint('http://gpu:8000///');
    expect(p.isConfigured()).toBe(true);
  });

  it('withApiKey returns self (no-op)', () => {
    const p = new SelfHostedLLMProvider('runpod');
    expect(p.withApiKey('key')).toBe(p);
  });

  it('withConfig delegates to withEndpoint when baseURL provided', () => {
    const p = new SelfHostedLLMProvider('runpod').withConfig({ apiKey: 'x', baseURL: 'http://gpu:8000' });
    expect(p.isConfigured()).toBe(true);
  });

  it('withConfig is no-op without baseURL', () => {
    const p = new SelfHostedLLMProvider('runpod').withConfig({ apiKey: 'x' });
    expect(p.isConfigured()).toBe(false);
  });
});
