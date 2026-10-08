import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildServeProviders, checkOpenRouterKey, deepHealthReport, parseModelRoutes, providersOfKeys, replaceProviderMapping,
  type ServeInstances,
} from '../../../src/config/serve-providers';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { breakerKey } from '../../../src/gateway/proxy/provider-routing';
import { handleModelsWithDynamic } from '../../../src/gateway/proxy/routes/models';
import { probeCloudProvider } from '../../../src/gateway/providers/cloud/cloud-health';
import { parleRoutes } from './_parle-routes';

const keys: Record<string, boolean> = {};
const p = (providerId: string) => ({ providerId, isConfigured: () => Boolean(keys[providerId]) }) as never;

function instances(): ServeInstances {
  return {
    chat: { groq: p('groq'), openrouter: p('openrouter'), zai: p('zai') },
    stt: { groq: p('groq'), openrouter: p('openrouter'), openai: p('openai'), fireworks: p('fireworks'), deepgram: p('deepgram') },
    tts: { groq: p('groq'), openrouter: p('openrouter') },
  };
}

afterEach(() => { for (const k of Object.keys(keys)) delete keys[k]; });

describe('buildServeProviders — only configured providers are mounted', () => {
  it('no keys: nothing mounted, every known model is unavailable with the missing key named', async () => {
    const { providers } = buildServeProviders({ instances: instances(), openrouter: { state: 'missing' } });
    expect(providers.chatRoutes).toEqual({});
    expect(providers.stt).toEqual({});
    expect(providers.chatDynamicRoutes?.[0].unavailableReason).toMatch(/OPENROUTER_API_KEY/);
    expect(providers.unavailable?.chat?.['llama-3.3-70b-versatile']).toEqual(['groq: GROQ_API_KEY is not set', 'openrouter: OPENROUTER_API_KEY is not set']);
    expect(providers.unavailable?.stt?.['whisper-large-v3']).toContain('groq: GROQ_API_KEY is not set');
    expect((await handleModelsWithDynamic(providers)).body).toEqual({ object: 'list', data: [] });
  });

  it('Groq + valid OpenRouter: Groq first, OpenRouter with the equivalent id as fallback', () => {
    keys.groq = true; keys.openrouter = true;
    const { providers } = buildServeProviders({ instances: instances(), openrouter: { state: 'valid' }, listOpenRouterModels: async () => [] });
    expect(providers.chatRoutes?.['llama-3.3-70b-versatile']?.map(t => `${t.providerId}:${t.model}`))
      .toEqual(['groq:llama-3.3-70b-versatile', 'openrouter:meta-llama/llama-3.3-70b-instruct']);
    expect(providers.chatRoutes?.['groq/compound']?.map(t => t.providerId)).toEqual(['groq']);
    expect(providers.stt?.['whisper-large-v3-turbo']?.map(t => t.providerId)).toEqual(['groq', 'openrouter']);
    expect(providers.chatDynamicRoutes).toHaveLength(1);
    expect(providers.dynamicModelCatalogs).toHaveLength(1);
    expect(providers.chatFallbackChain?.map(e => e.providerId)).toEqual(['groq', 'openrouter']);
  });

  it('a rejected OpenRouter key is not mounted (no dynamic route, no catalog) and the reason says so', () => {
    keys.openrouter = true;
    const { providers } = buildServeProviders({ instances: instances(), openrouter: { state: 'invalid', detail: 'HTTP 401' } });
    expect(providers.chatDynamicRoutes?.[0].unavailableReason).toMatch(/OPENROUTER_API_KEY/);
    expect(providers.dynamicModelCatalogs).toBeUndefined();
    expect(providers.unavailable?.chat?.['qwen/qwen3-32b']).toContain('openrouter: OPENROUTER_API_KEY was rejected by OpenRouter (HTTP 401)');
  });

  it('an unreachable key check keeps OpenRouter routing but not the catalog', () => {
    keys.openrouter = true;
    const { providers } = buildServeProviders({ instances: instances(), openrouter: { state: 'unknown' }, listOpenRouterModels: async () => [] });
    expect(providers.chatDynamicRoutes).toHaveLength(1);
    expect(providers.dynamicModelCatalogs).toBeUndefined();
  });

  it('PlayAI TTS (retired by Groq) is not offered', () => {
    keys.groq = true;
    const { providers } = buildServeProviders({ instances: instances(), openrouter: { state: 'missing' } });
    expect(Object.keys(providers.tts ?? {})).not.toContain('playai-tts');
    expect(Object.keys(providers.tts ?? {})).toContain('canopylabs/orpheus-v1-english');
  });

  it("an app's aliases: deployment first, OpenRouter fallback; deployment names from its routes", () => {
    keys.openrouter = true;
    const deploymentProvider = vi.fn((_stage: string, name: string) => ({ providerId: 'self-hosted', isConfigured: () => name === 'my-tts' }) as never);
    const { providers } = buildServeProviders({
      instances: instances(), openrouter: { state: 'valid' }, deploymentProvider, appRoutes: parleRoutes({ tts: 'my-tts' }),
    });
    expect(providers.tts?.['parle-tts']?.map(t => `${t.providerId}:${t.model}`))
      .toEqual(['deployment:my-tts:Qwen/Qwen3-TTS-12Hz-0.6B-Base', 'openrouter:microsoft/mai-voice-2.1-flash', 'openrouter:hexgrad/kokoro-82m']);
    // Kokoro, the last resort, keeps its own voice: the client's fallback_voice is a MAI voice.
    expect(providers.tts?.['parle-tts']?.[2]).toMatchObject({ voice: 'pf_dora', fixedVoice: true });
    expect(providers.chatRoutes?.['parle-llm']?.[0].providerId).toBe('deployment:parle-speech');
    expect(providers.stt?.['parle-stt']?.map(t => t.providerId)).toEqual(['deployment:parle-speech', 'openrouter']);
  });

  it("without deployments an app's aliases still serve from OpenRouter", () => {
    keys.openrouter = true;
    const { providers } = buildServeProviders({ instances: instances(), openrouter: { state: 'valid' }, appRoutes: parleRoutes() });
    expect(providers.chatRoutes?.['parle-llm']?.map(t => t.model)).toEqual(['qwen/qwen3.5-9b', 'google/gemini-2.5-flash-lite']);
  });

  it('MODEL_ROUTES replaces a chain and accepts string and object entries', () => {
    keys.openrouter = true; keys.groq = true;
    const { routes, errors } = parseModelRoutes(JSON.stringify({
      chat: { 'my-llm': ['openrouter:qwen/qwen3.5-9b:free', 'groq:llama-3.3-70b-versatile'] },
      tts: { 'my-tts': [{ provider: 'openrouter', model: 'fish-audio/s2-pro', voice: 'v1' }, 42] },
    }));
    expect(errors).toEqual(['MODEL_ROUTES.tts.my-tts: invalid entry skipped']);
    const { providers } = buildServeProviders({ instances: instances(), openrouter: { state: 'valid' }, modelRoutes: routes });
    expect(providers.chatRoutes?.['my-llm']?.map(t => t.model)).toEqual(['qwen/qwen3.5-9b:free', 'llama-3.3-70b-versatile']);
    expect(providers.tts?.['my-tts']?.[0]).toMatchObject({ model: 'fish-audio/s2-pro', voice: 'v1' });
    expect(parseModelRoutes('{oops').errors).toEqual(['MODEL_ROUTES is not valid JSON']);
  });

  it('a provider that loses its key disappears from /v1/models on the next listing', async () => {
    keys.groq = true;
    const { providers } = buildServeProviders({ instances: instances(), openrouter: { state: 'missing' } });
    const ids = async () => ((await handleModelsWithDynamic(providers)).body as { data: Array<{ id: string }> }).data.map(m => m.id);
    expect(await ids()).toContain('llama-3.3-70b-versatile');
    delete keys.groq;
    expect(await ids()).toEqual([]);
  });

  it('replaceProviderMapping swaps the live object in place', () => {
    const live: Record<string, unknown> = { chat: {}, old: 1 };
    replaceProviderMapping(live, { chat: { a: 1 }, stt: {} });
    expect(live).toEqual({ chat: { a: 1 }, stt: {} });
    expect(providersOfKeys(['OPENROUTER_API_KEY', 'X'])).toEqual(['openrouter']);
  });
});

describe('OpenRouter key check (/api/v1/key — /models is public and proves nothing)', () => {
  it('valid / invalid / unknown, never throwing', async () => {
    const ok = vi.fn(async () => Response.json({ data: {} }));
    expect(await checkOpenRouterKey({ OPENROUTER_API_KEY: 'k' }, ok as never)).toEqual({ state: 'valid' });
    expect(String((ok.mock.calls[0] as unknown[])[0])).toBe('https://openrouter.ai/api/v1/key');
    const denied = vi.fn(async () => new Response('', { status: 401 }));
    expect(await checkOpenRouterKey({ OPENROUTER_API_KEY: 'k' }, denied as never)).toEqual({ state: 'invalid', detail: 'HTTP 401' });
    const down = vi.fn(async () => { throw new Error('ETIMEDOUT'); });
    expect((await checkOpenRouterKey({ OPENROUTER_API_KEY: 'k' }, down as never)).state).toBe('unknown');
    expect(await checkOpenRouterKey({}, down as never)).toEqual({ state: 'missing' });
  });

  it('probeCloudProvider hits /api/v1/key for openrouter', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    const r = await probeCloudProvider('openrouter', 'k', 1000, fetchImpl as never);
    expect(r).toMatchObject({ ok: false, error: 'HTTP 401' });
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('/api/v1/key');
  });
});

describe('deep health report', () => {
  it('reports each provider (configured or not), circuits and deployments, without any key value', async () => {
    const env = { GROQ_API_KEY: 'gsk_secretvalue000001', OPENROUTER_API_KEY: 'sk-or-v1-secretvalue000002' };
    const fetchImpl = vi.fn(async (url: string) => (String(url).includes('openrouter') ? new Response('', { status: 401 }) : Response.json({})));
    const breakers = new CircuitBreakerRegistry();
    breakers.get(breakerKey('chat', { providerId: 'deployment:parle-speech' })).recordFailure();
    const { status, body } = await deepHealthReport({
      env, fetchImpl: fetchImpl as never, breakers, providers: { chatRoutes: {}, stt: {}, tts: {}, unavailable: { chat: { x: ['r'] } } },
      deployments: {
        health: () => ({ deployments: 1, replicas: 0, listError: null }),
        list: () => [{ name: 'parle-speech', status: 'scaled-to-zero', replicas: [], lastError: null }],
      },
    });
    expect(status).toBe(200);
    const text = JSON.stringify(body);
    expect(text).not.toContain(env.GROQ_API_KEY);
    expect(text).not.toContain(env.OPENROUTER_API_KEY);
    const b = body as { status: string; providers: Array<{ provider: string; ok: boolean | null; configured: boolean; error?: string }>; deployments: { items: unknown[] }; circuits: Record<string, unknown> };
    expect(b.status).toBe('degraded');
    expect(b.providers.find(x => x.provider === 'openrouter')).toMatchObject({ configured: true, ok: false, error: 'HTTP 401' });
    expect(b.providers.find(x => x.provider === 'groq')).toMatchObject({ ok: true });
    expect(b.providers.find(x => x.provider === 'openai')).toMatchObject({ configured: false, error: 'OPENAI_API_KEY is not set' });
    expect(b.deployments.items).toEqual([{ name: 'parle-speech', status: 'scaled-to-zero', replicas: 0, ready: 0, lastError: null, stagesOut: [] }]);
    expect(b.circuits['chat:deployment:parle-speech']).toBeDefined();
  });
});
