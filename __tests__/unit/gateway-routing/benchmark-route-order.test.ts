import { describe, expect, it, vi } from 'vitest';
import { buildServeProviders, parseModelRoutes, type ServeInstances } from '../../../src/config/serve-providers';
import { parleRoutes } from './_parle-routes';

const p = (providerId: string) => ({ providerId, isConfigured: () => true }) as never;
const instances = (): ServeInstances => ({
  chat: { groq: p('groq'), openrouter: p('openrouter') },
  stt: { groq: p('groq'), openrouter: p('openrouter'), openai: p('openai'), deepgram: p('deepgram') },
  tts: { groq: p('groq'), openrouter: p('openrouter') },
});
const deploymentProvider = () => ({ providerId: 'self-hosted', isConfigured: () => true }) as never;

const sttChain = (order?: object) => ({
  stt: {
    'parle-stt': [
      { provider: 'deployment', deployment: 'parle-speech', model: 'whisper-large-v3-turbo', ...order },
      { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' },
      { provider: 'groq', model: 'whisper-large-v3-turbo' },
      { provider: 'openai', model: 'whisper-1' },
      { provider: 'deepgram', model: 'nova-3' },
    ],
  },
});

const benchmarkRank = vi.fn(() => new Map([['deepgram:nova-3', 0], ['groq:whisper-large-v3-turbo', 1], ['deployment:whisper-large-v3-turbo', 2]]));

function sttOrder(raw: object, rank = benchmarkRank) {
  const { routes, errors } = parseModelRoutes(JSON.stringify(raw));
  expect(errors).toEqual([]);
  const built = buildServeProviders({ instances: instances(), openrouter: { state: 'valid' }, deploymentProvider, appRoutes: routes, benchmarkRank: rank });
  return built.providers.stt?.['parle-stt']?.map(t => `${t.providerId}:${t.model}`);
}

describe('route order "benchmark"', () => {
  it('reorders only the fallbacks after the primary by rank; unranked keep their relative order after the ranked', () => {
    expect(sttOrder(sttChain({ order: 'benchmark', benchmarkDataset: 'elevenlabs-pt-l2-v1' }))).toEqual([
      'deployment:parle-speech:whisper-large-v3-turbo', 'deepgram:nova-3', 'groq:whisper-large-v3-turbo',
      'openrouter:openai/whisper-large-v3-turbo', 'openai:whisper-1',
    ]);
    expect(benchmarkRank).toHaveBeenCalledWith('stt', 'elevenlabs-pt-l2-v1');
  });

  it('a route without the option keeps its declared order and never asks for a rank', () => {
    const rank = vi.fn(() => new Map([['deepgram:nova-3', 0]]));
    expect(sttOrder(sttChain(), rank)).toEqual([
      'deployment:parle-speech:whisper-large-v3-turbo', 'openrouter:openai/whisper-large-v3-turbo', 'groq:whisper-large-v3-turbo',
      'openai:whisper-1', 'deepgram:nova-3',
    ]);
    const built = buildServeProviders({ instances: instances(), openrouter: { state: 'valid' }, deploymentProvider, appRoutes: parleRoutes(), benchmarkRank: rank });
    expect(built.providers.stt?.['parle-stt']?.map(t => t.providerId)).toEqual(['deployment:parle-speech', 'openrouter', 'groq']);
    expect(rank).not.toHaveBeenCalled();
  });

  it('the option survives parsing; an invalid order or a missing dataset is refused', () => {
    expect(parseModelRoutes(JSON.stringify(sttChain({ order: 'benchmark', benchmarkDataset: 'd' }))).routes.stt?.['parle-stt']?.[0])
      .toMatchObject({ order: 'benchmark', benchmarkDataset: 'd' });
    expect(parseModelRoutes(JSON.stringify(sttChain({ order: 'benchmark' }))).errors).toHaveLength(1);
    expect(parseModelRoutes(JSON.stringify(sttChain({ order: 'latency', benchmarkDataset: 'd' }))).errors).toHaveLength(1);
  });
});
