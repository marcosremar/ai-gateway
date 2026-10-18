/**
 * Every alias chain ends in the cloud (owner decision 2026-10-12). Regression of the babelcast audit (2026-10-12, M2/M3):
 * `babelcast-stt` and `babelcast-tts` had only their GPU deployment, so with the GPUs off the app got 503 at once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CLOUD_FALLBACK, withCloudFallback } from '../../../src/config/cloud-fallback';
import { buildServeProviders, type ModelRoutesSpec, type ServeInstances } from '../../../src/config/serve-providers';
import { AppError, AppRegistry, MemoryAppStore, type AppAccount } from '../../../src/deployments/apps';

const BABELCAST: ModelRoutesSpec = {
  chat: { 'babelcast-llm': [{ provider: 'deployment', deployment: 'babelcast-speech', model: 'qwen3.5-9b', extraBody: { chat_template_kwargs: { enable_thinking: false } } }] },
  stt: { 'babelcast-stt': [{ provider: 'deployment', deployment: 'babelcast-speech', model: 'whisper-large-v3-turbo' }] },
  tts: { 'babelcast-tts': [{ provider: 'deployment', deployment: 'babelcast-tts', model: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice' }] },
};
const PARLE_STT: ModelRoutesSpec = {
  stt: { 'parle-stt': [{ provider: 'deployment', deployment: 'parle-speech' }, { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' }] },
};
const targets = (chain: Array<{ provider: string; model?: string; deployment?: string }> | undefined) =>
  (chain ?? []).map(e => (e.provider === 'deployment' ? `deployment:${e.deployment}` : `${e.provider}:${e.model}`));

describe('withCloudFallback', () => {
  it('appends the stage default to a GPU-only chain, after what was there', () => {
    const { routes, added } = withCloudFallback(BABELCAST);
    expect(targets(routes.stt?.['babelcast-stt'])).toEqual(['deployment:babelcast-speech', 'openrouter:openai/whisper-large-v3-turbo', 'groq:whisper-large-v3-turbo']);
    expect(targets(routes.chat?.['babelcast-llm'])).toEqual(['deployment:babelcast-speech', 'openrouter:google/gemini-2.5-flash-lite']);
    expect(targets(routes.tts?.['babelcast-tts'])).toEqual(['deployment:babelcast-tts', 'openrouter:hexgrad/kokoro-82m']);
    expect(routes.chat?.['babelcast-llm']?.[0]).toEqual(BABELCAST.chat!['babelcast-llm'][0]);
    expect(added.map(a => `${a.stage} ${a.alias}`)).toEqual(['chat babelcast-llm', 'stt babelcast-stt', 'tts babelcast-tts']);
  });

  it('leaves a chain that already has a cloud link, and the generic `*` chat fallback, as they are', () => {
    const star = { chat: { '*': [{ provider: 'deployment', deployment: 'x' }] } };
    expect(withCloudFallback(PARLE_STT)).toEqual({ routes: PARLE_STT, added: [] });
    expect(withCloudFallback(star).added).toEqual([]);
  });

  it('never shares the default entries between chains (a later edit of one cannot change another)', () => {
    const { routes } = withCloudFallback(BABELCAST);
    expect(routes.tts?.['babelcast-tts']?.[1]).not.toBe(DEFAULT_CLOUD_FALLBACK.tts[0]);
  });
});

describe('app routes: a chain without a cloud link is completed, an explicit opt-out is refused', () => {
  it('PUT routes appends the default and says what it added', async () => {
    const apps = new AppRegistry(new MemoryAppStore());
    const { routes, cloudFallbackAdded } = await apps.putRoutes('babelcast', BABELCAST);
    expect(cloudFallbackAdded.map(a => a.alias)).toEqual(['babelcast-llm', 'babelcast-stt', 'babelcast-tts']);
    expect(targets(apps.get('babelcast')?.routes?.stt?.['babelcast-stt'])).toEqual(targets(routes.stt?.['babelcast-stt']));
    expect(targets(routes.stt?.['babelcast-stt'])).toContain('openrouter:openai/whisper-large-v3-turbo');
  });

  it('babelcast-tts-kokoro (docs/deployments.md): the speech-stack GPUs with model kokoro, then OpenRouter Kokoro; nothing appended', async () => {
    const apps = new AppRegistry(new MemoryAppStore());
    const kokoro = { tts: { 'babelcast-tts-kokoro': [
      'deployment:babelcast-3090:kokoro', 'deployment:babelcast-speech:kokoro', 'openrouter:hexgrad/kokoro-82m',
    ] } };
    const { routes, cloudFallbackAdded } = await apps.putRoutes('babelcast', kokoro, {
      restrictedTo: d => d.startsWith('babelcast-'), appOf: d => (d.startsWith('babelcast-') ? 'babelcast' : null),
    });
    expect(cloudFallbackAdded).toEqual([]);
    expect(routes.tts?.['babelcast-tts-kokoro']).toEqual([
      { provider: 'deployment', deployment: 'babelcast-3090', model: 'kokoro' },
      { provider: 'deployment', deployment: 'babelcast-speech', model: 'kokoro' },
      { provider: 'openrouter', model: 'hexgrad/kokoro-82m' },
    ]);
  });

  it('"cloudFallback": false is refused with a clear 400 and nothing is saved', async () => {
    const apps = new AppRegistry(new MemoryAppStore());
    const err = await apps.putRoutes('babelcast', { ...BABELCAST, cloudFallback: false }).catch(e => e as AppError);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(400);
    expect((err as AppError).message).toMatch(/must end in a cloud fallback/);
    expect(apps.get('babelcast')).toBeNull();
  });

  it('an app key may name the default fallback targets even when its routes never had them', async () => {
    const apps = new AppRegistry(new MemoryAppStore());
    await apps.putRoutes('site-a', PARLE_STT);
    const chain = { stt: { 'parle-stt': [{ provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' }, { provider: 'groq', model: 'whisper-large-v3-turbo' }] } };
    await expect(apps.putRoutes('site-a', chain, { restrictedTo: () => false })).resolves.toBeTruthy();
  });

  it('boot migration completes the stored GPU-only chains and keeps everything else', async () => {
    const store = new MemoryAppStore();
    const stored: Record<string, AppAccount> = {
      babelcast: { id: 'babelcast', createdAt: 1, images: {}, routes: BABELCAST, limits: { dailyRequests: 9 } },
      parle: { id: 'parle', createdAt: 2, images: {}, routes: PARLE_STT },
    };
    await store.save(stored);
    const apps = new AppRegistry(store);
    await apps.init();
    const added = await apps.ensureCloudFallback();
    expect(added.map(a => `${a.app} ${a.alias}`)).toEqual(['babelcast babelcast-llm', 'babelcast babelcast-stt', 'babelcast babelcast-tts']);
    const saved = await store.load();
    expect(targets(saved.babelcast.routes?.tts?.['babelcast-tts'])[0]).toBe('deployment:babelcast-tts');
    expect(targets(saved.babelcast.routes?.tts?.['babelcast-tts'])).toContain('openrouter:hexgrad/kokoro-82m');
    expect(saved.babelcast.limits).toEqual({ dailyRequests: 9 });
    expect(saved.parle.routes).toEqual(PARLE_STT);
    expect(await apps.ensureCloudFallback()).toEqual([]);
  });
});

describe('mounting: a GPU-only chain is served by the cloud when its deployment cannot answer', () => {
  const keys: Record<string, boolean> = {};
  const p = (providerId: string) => ({ providerId, isConfigured: () => Boolean(keys[providerId]) }) as never;
  const instances = (): ServeInstances => ({
    chat: { groq: p('groq'), openrouter: p('openrouter') },
    stt: { groq: p('groq'), openrouter: p('openrouter') },
    tts: { groq: p('groq'), openrouter: p('openrouter') },
  });
  afterEach(() => { for (const k of Object.keys(keys)) delete keys[k]; });

  it('app routes and MODEL_ROUTES alike get the default appended, reported in the summary', () => {
    keys.groq = true;
    const built = buildServeProviders({
      instances: instances(), openrouter: { state: 'valid' }, appRoutes: BABELCAST,
      modelRoutes: { stt: { 'env-stt': [{ provider: 'deployment', deployment: 'gone' }] } },
    });
    expect(built.providers.stt?.['babelcast-stt']?.map(t => `${t.providerId}:${t.model}`))
      .toEqual(['openrouter:openai/whisper-large-v3-turbo', 'groq:whisper-large-v3-turbo']);
    expect(built.providers.chatRoutes?.['babelcast-llm']?.map(t => t.model)).toEqual(['google/gemini-2.5-flash-lite']);
    expect(built.providers.tts?.['babelcast-tts']?.map(t => t.model)).toEqual(['hexgrad/kokoro-82m']);
    expect(built.providers.stt?.['env-stt']?.length).toBe(2);
    expect(built.summary.cloudFallbackAdded).toEqual(expect.arrayContaining([expect.stringMatching(/^stt env-stt \+ openrouter/)]));
    expect(built.chains.stt['babelcast-stt'].map(l => l.target)).toEqual(['deployment:babelcast-speech', 'openrouter:openai/whisper-large-v3-turbo', 'groq:whisper-large-v3-turbo']);
  });
});
