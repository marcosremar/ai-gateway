import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServeProviders, type ServeInstances } from '../../../src/config/serve-providers';
import { mistralSTT } from '../../../src/gateway/providers/cloud/mistral';
import { isCloudLink } from '../../../src/config/cloud-fallback';

const keys: Record<string, boolean> = {};
const p = (providerId: string) => ({ providerId, isConfigured: () => Boolean(keys[providerId]) }) as never;

function instances(): ServeInstances {
  return {
    chat: { openrouter: p('openrouter') },
    stt: { openrouter: p('openrouter'), groq: p('groq'), mistral: p('mistral') },
    tts: { openrouter: p('openrouter') },
  };
}

const sttChain = [
  { provider: 'deployment', deployment: 'speech', model: 'whisper-large-v3-turbo' },
  { provider: 'mistral', model: 'voxtral-mini-latest' },
  { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' },
];

afterEach(() => {
  for (const k of Object.keys(keys)) delete keys[k];
  vi.unstubAllEnvs();
});

describe('Mistral Voxtral STT: an EU cloud fallback for a cold deployment', () => {
  it('an app chain with a mistral link mounts it after the deployment, as a cloud link', () => {
    keys.openrouter = true; keys.mistral = true;
    const deploymentProvider = () => ({ providerId: 'self-hosted', isConfigured: () => true }) as never;
    const { providers } = buildServeProviders({
      instances: instances(), openrouter: { state: 'valid' }, deploymentProvider,
      appRoutes: { stt: { 'app-stt': sttChain } } as never,
    });
    expect(providers.stt?.['app-stt']?.map(t => `${t.providerId}:${t.model}`))
      .toEqual(['deployment:speech:whisper-large-v3-turbo', 'mistral:voxtral-mini-latest', 'openrouter:openai/whisper-large-v3-turbo']);
    expect(isCloudLink({ provider: 'mistral', model: 'voxtral-mini-latest' })).toBe(true);
  });

  it('without MISTRAL_API_KEY the link is skipped with the missing key named, the chain goes on', () => {
    keys.openrouter = true;
    const deploymentProvider = () => ({ providerId: 'self-hosted', isConfigured: () => true }) as never;
    const { providers } = buildServeProviders({
      instances: instances(), openrouter: { state: 'valid' }, deploymentProvider,
      appRoutes: { stt: { 'app-stt': sttChain } } as never,
    });
    expect(providers.stt?.['app-stt']?.map(t => t.providerId)).toEqual(['deployment:speech', 'openrouter']);
    expect(providers.unavailable?.stt?.['app-stt']).toContain('mistral: MISTRAL_API_KEY is not set');
  });

  it('is configured by MISTRAL_API_KEY and defaults to Voxtral on the EU endpoint', () => {
    vi.stubEnv('MISTRAL_API_KEY', '');
    expect(mistralSTT.isConfigured()).toBe(false);
    vi.stubEnv('MISTRAL_API_KEY', 'test-key');
    expect(mistralSTT.isConfigured()).toBe(true);
    expect(mistralSTT.getModels().map(m => m.id)).toEqual(['voxtral-mini-latest']);
    expect(readFileSync(join(__dirname, '../../../src/gateway/providers/cloud/mistral/index.ts'), 'utf8')).toContain("'https://api.eu.mistral.ai/v1'");
  });

  it('serve.ts mounts it among the STT instances', () => {
    const serve = readFileSync(join(__dirname, '../../../serve.ts'), 'utf8');
    expect(serve).toMatch(/stt: \{[^}]*mistral: mistralSTT/);
  });
});
