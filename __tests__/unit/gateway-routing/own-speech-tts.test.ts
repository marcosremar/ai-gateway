/**
 * The gateway's own speech server (docker/kokoro-stream: Kokoro, and Pocket TTS with POCKET_TTS=1) as a link of the
 * app TTS chains (route-tts.ts). Production 2026-10-19, right after a deploy: both babelcast GPUs off and OpenRouter
 * timing out at the 8 s TTS budget → the app's dubbing line got 503 provider_unavailable. With the speech server in the
 * chain between the deployments and OpenRouter the line is spoken by it; it only takes wav/pcm and a language it has.
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServeProviders, parseModelRoutes, type ServeInstances } from '../../../src/config/serve-providers';
import { isCloudLink, withCloudFallback } from '../../../src/config/cloud-fallback';
import {
  kokoroStreamVoice, languageCode, OWN_TTS_HEDGE_MS, OWN_TTS_TIMEOUT_MS, ownSpeechProviders, pocketVoice, QWEN_PRESET_GENDERS,
} from '../../../src/gateway/providers/cloud/kokoro-stream/route-tts';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import type { TTSRequest } from '../../../src/gateway/providers/cloud/types';
import { breakerKey, DEFAULT_STAGE_BUDGET_MS } from '../../../src/gateway/proxy/provider-routing';
import { handleAudioSpeech } from '../../../src/gateway/proxy/routes/audio-speech';
import type { ProxyRequest } from '../../../src/gateway/proxy/types';
import { fallbackLinks, probeLink } from '../../../src/telemetry/fallback-probe';

const KOKORO = 'hexgrad/kokoro-82m';

/** babelcast's chains as the admin call in docs/rooms.md § "Own speech server in the app chains" writes them. */
const ROUTES = {
  tts: {
    'babelcast-tts': [
      { provider: 'deployment', deployment: 'babelcast-tts-clone' },
      { provider: 'deployment', deployment: 'babelcast-tts' },
      { provider: 'kokoro-stream', model: KOKORO },
      { provider: 'openrouter', model: KOKORO, voices: { feminine: 'af_heart', masculine: 'am_michael' }, voiceGenders: QWEN_PRESET_GENDERS, preferFallbackVoice: true },
    ],
    'babelcast-tts-pocket': [
      { provider: 'pocket', model: 'pocket' },
      { provider: 'kokoro-stream', model: KOKORO },
      { provider: 'openrouter', model: KOKORO, voices: { feminine: 'af_heart', masculine: 'am_michael' }, voiceGenders: QWEN_PRESET_GENDERS, preferFallbackVoice: true },
    ],
    // The order NOT recommended, to show the budget still holds: OpenRouter before the speech server.
    'cloud-first': [
      { provider: 'openrouter', model: KOKORO, voices: { feminine: 'af_heart', masculine: 'am_michael' } },
      { provider: 'kokoro-stream', model: KOKORO },
    ],
  },
};

// ── A fake speech server: what docker/kokoro-stream/server.py answers ─────────────────────────────────────────────

type Mode = 'ok' | 'hang' | 'busy' | 'loading';
let server: Server;
let base = '';
const seen: Array<Record<string, unknown>> = [];
const mode: Record<'kokoro' | 'pocket', Mode> = { kokoro: 'ok', pocket: 'ok' };
const open: ServerResponse[] = [];
const PCM = Buffer.alloc(4_800, 7); // 0.1 s of 24 kHz s16

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body) as Record<string, unknown>;
      seen.push({ ...json, authorization: req.headers.authorization });
      const m = mode[json.model === 'pocket' ? 'pocket' : 'kokoro'];
      if (m === 'busy' || m === 'loading') {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: m, message: m } }));
        return;
      }
      res.writeHead(200, { 'content-type': `audio/${json.response_format};rate=24000` });
      res.flushHeaders();
      if (m === 'hang') { open.push(res); return; }
      res.write(PCM);
      setTimeout(() => res.end(PCM), 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

beforeEach(() => {
  vi.stubEnv('KOKORO_STREAM_API_KEY', 'test-kokoro-key');
  vi.stubEnv('POCKET_TTS_API_KEY', 'test-pocket-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
  seen.length = 0;
  mode.kokoro = 'ok';
  mode.pocket = 'ok';
  for (const res of open.splice(0)) res.destroy();
});

// ── The rest of the chain: cold deployments and an OpenRouter that hangs (or answers) ──────────────────────────────

const coldDeployment = {
  providerId: 'self-hosted', getModels: () => [], getVoices: () => [], isConfigured: () => true, synthesizeStream: vi.fn(),
  synthesize: vi.fn(async () => {
    throw Object.assign(new Error("deployment 'babelcast-tts-clone': no replica ready (parked)"), { status: 503, gatewayCode: 'cold', skipRetry: true });
  }),
};

function fakeOpenRouter(behaviour: 'hang' | 'answer') {
  const calls: TTSRequest[] = [];
  const provider = {
    providerId: 'openrouter', getModels: () => [], getVoices: () => [], isConfigured: () => true, synthesizeStream: vi.fn(),
    synthesize: vi.fn((req: TTSRequest) => {
      calls.push(req);
      if (behaviour === 'answer') return Promise.resolve({ audio: Buffer.from([0xff, 0xf3, 1, 2]), contentType: 'audio/mpeg' });
      return new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }),
  };
  return { provider, calls };
}

function setup(opts: { openrouter?: 'hang' | 'answer'; env?: Record<string, string> } = {}) {
  const openrouter = fakeOpenRouter(opts.openrouter ?? 'hang');
  const none = { providerId: 'x', isConfigured: () => false } as never;
  const instances: ServeInstances = {
    chat: {}, stt: {},
    tts: { openrouter: openrouter.provider as never, ...ownSpeechProviders({ KOKORO_STREAM_URL: base }) },
  };
  const { routes, errors } = parseModelRoutes(JSON.stringify(ROUTES));
  expect(errors).toEqual([]);
  const built = buildServeProviders({
    instances, openrouter: { state: 'valid' }, env: opts.env ?? {}, appRoutes: routes,
    deploymentExists: () => true,
    deploymentProvider: (stage) => (stage === 'tts' ? coldDeployment : none) as never,
  });
  const breakers = new CircuitBreakerRegistry({ failureThreshold: 5, resetTimeoutMs: 30_000 });
  const speak = (body: Record<string, unknown>) => handleAudioSpeech(
    { method: 'POST', url: '/v1/audio/speech', headers: {}, body, rawBody: Buffer.alloc(0) } as ProxyRequest,
    built.providers.tts!, built.providers.unavailable?.tts, breakers,
  );
  return { built, speak, openrouter, breakers };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  return Buffer.concat(chunks);
}

/** What the desktop app sends for a dubbed line (bc-gateway-client `tts_body` + `tts_in` language). */
const DUB = { model: 'babelcast-tts', input: 'Bom dia a todos, vamos começar.', voice: 'Ryan', response_format: 'wav', language: 'Portuguese' };

describe('babelcast-tts with the GPUs off: the speech server speaks the line', () => {
  it('both deployments cold and OpenRouter hanging: Kokoro on the speech server answers, well inside the 8 s budget', async () => {
    const { speak, openrouter } = setup({ openrouter: 'hang' });
    const started = Date.now();
    const res = await speak(DUB);
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toBe(`kokoro-stream:${KOKORO}`);
    expect(res.headers?.['X-Gateway-Fallback']).toBe('cold');
    const wav = await readAll(res.stream!);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.length).toBe(44 + 2 * PCM.length);
    expect(Date.now() - started).toBeLessThan(DEFAULT_STAGE_BUDGET_MS / 4);
    expect(openrouter.calls).toHaveLength(0);
    // Portuguese gets the Portuguese voice ("Ryan" is a Qwen3 preset the Kokoro server does not know), as PCM.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ voice: 'pf_dora', response_format: 'pcm', input: DUB.input, authorization: 'Bearer test-kokoro-key' });
  });

  it('the speech server stuck before its first audio: OpenRouter starts at the hedge and answers', async () => {
    mode.kokoro = 'hang';
    const { speak, openrouter } = setup({ openrouter: 'answer', env: { OWN_TTS_HEDGE_MS: '150' } });
    const started = Date.now();
    const res = await speak(DUB);
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toBe(`openrouter:${KOKORO}`);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(openrouter.calls).toHaveLength(1);
    expect(openrouter.calls[0]!.voice).toBe('am_michael');
  });

  it('busy speech server (503): OpenRouter right away', async () => {
    mode.kokoro = 'busy';
    const { speak, openrouter } = setup({ openrouter: 'answer' });
    const res = await speak(DUB);
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toBe(`openrouter:${KOKORO}`);
    expect(openrouter.calls).toHaveLength(1);
  });

  it('the default hedge and first-audio limit leave the cloud link most of the budget', () => {
    expect(OWN_TTS_HEDGE_MS).toBeLessThanOrEqual(DEFAULT_STAGE_BUDGET_MS / 4);
    expect(OWN_TTS_TIMEOUT_MS).toBeLessThan(DEFAULT_STAGE_BUDGET_MS);
    const target = setup().built.providers.tts!['babelcast-tts']!.find(t => t.providerId === 'kokoro-stream')!;
    expect(target).toMatchObject({ hedgeAfterMs: OWN_TTS_HEDGE_MS, timeoutMs: OWN_TTS_TIMEOUT_MS });
  });

  it('even behind a hanging OpenRouter the speech server answers before the budget ends (cloud hedge)', async () => {
    vi.stubEnv('GATEWAY_TTS_BUDGET_MS', '2000');
    const { speak, openrouter } = setup({ openrouter: 'hang' });
    const started = Date.now();
    const res = await speak({ ...DUB, model: 'cloud-first' });
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toBe(`kokoro-stream:${KOKORO}`);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(openrouter.calls).toHaveLength(1);
  });
});

describe('only what the speech server can say goes to it', () => {
  it('an mp3 request skips it without calling it or feeding its breaker', async () => {
    const { speak, openrouter, breakers } = setup({ openrouter: 'answer' });
    const res = await speak({ ...DUB, response_format: 'mp3' });
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toBe(`openrouter:${KOKORO}`);
    expect(seen).toHaveLength(0);
    expect(openrouter.calls).toHaveLength(1);
    expect(breakers.peek(breakerKey('tts', { providerId: 'kokoro-stream', model: KOKORO }))?.getStats().failures ?? 0).toBe(0);
  });

  it('pcm is served too', async () => {
    const { speak } = setup();
    const res = await speak({ ...DUB, response_format: 'pcm' });
    expect(res.headers?.['X-Gateway-Provider']).toBe(`kokoro-stream:${KOKORO}`);
    expect((await readAll(res.stream!)).length).toBe(2 * PCM.length);
  });

  it('a language it has no voice for (Japanese) goes to the next link', async () => {
    const { speak, openrouter } = setup({ openrouter: 'answer' });
    const res = await speak({ ...DUB, input: 'おはようございます', language: 'Japanese' });
    expect(res.headers?.['X-Gateway-Provider']).toBe(`openrouter:${KOKORO}`);
    expect(seen).toHaveLength(0);
    expect(openrouter.calls).toHaveLength(1);
  });

  it('the voice follows the language: French → ff_siwis, Spanish → ef_dora, English → af_heart', async () => {
    const { speak } = setup();
    for (const [language, voice] of [['French', 'ff_siwis'], ['es', 'ef_dora'], ['en-US', 'af_heart']] as const) {
      const res = await speak({ ...DUB, language });
      await readAll(res.stream!);
      expect(seen.at(-1)).toMatchObject({ voice });
    }
  });
});

describe('babelcast-tts-pocket: Pocket TTS on the same server', () => {
  it('Portuguese + "Ryan" → rafael, model pocket, with the language', async () => {
    const { speak } = setup();
    const res = await speak({ ...DUB, model: 'babelcast-tts-pocket' });
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toBe('pocket:pocket');
    expect((await readAll(res.stream!)).subarray(0, 4).toString()).toBe('RIFF');
    expect(seen[0]).toMatchObject({ model: 'pocket', voice: 'rafael', language: 'pt', response_format: 'pcm', authorization: 'Bearer test-pocket-key' });
  });

  it('a Pocket voice the app names is kept; a feminine preset in English gets alba', async () => {
    const { speak } = setup();
    await readAll((await speak({ ...DUB, model: 'babelcast-tts-pocket', voice: 'estelle' })).stream!);
    await readAll((await speak({ ...DUB, model: 'babelcast-tts-pocket', voice: 'Vivian', language: 'English', input: 'Good morning.' })).stream!);
    expect(seen.map(s => `${s.voice}/${s.language}`)).toEqual(['estelle/pt', 'alba/en']);
  });

  it('Pocket still loading its model (503): Kokoro on the same server speaks the line', async () => {
    mode.pocket = 'loading';
    const { speak } = setup();
    const res = await speak({ ...DUB, model: 'babelcast-tts-pocket' });
    expect(res.headers?.['X-Gateway-Provider']).toBe(`kokoro-stream:${KOKORO}`);
    await readAll(res.stream!);
    expect(seen.map(s => s.model)).toEqual(['pocket', KOKORO]);
  });

  it('without POCKET_TTS_API_KEY the link is not mounted (and says why); the alias still speaks', async () => {
    vi.stubEnv('POCKET_TTS_API_KEY', '');
    const { built, speak } = setup();
    expect(built.providers.tts!['babelcast-tts-pocket']!.map(t => t.providerId)).toEqual(['kokoro-stream', 'openrouter']);
    expect(built.providers.unavailable?.tts?.['babelcast-tts-pocket']).toEqual(['pocket: POCKET_TTS_API_KEY is not set']);
    const res = await speak({ ...DUB, model: 'babelcast-tts-pocket' });
    expect(res.headers?.['X-Gateway-Provider']).toBe(`kokoro-stream:${KOKORO}`);
    await readAll(res.stream!);
  });

  it('without any speech-server key nothing changes: GPUs → OpenRouter, as before', () => {
    vi.stubEnv('KOKORO_STREAM_API_KEY', '');
    vi.stubEnv('POCKET_TTS_API_KEY', '');
    const { built } = setup();
    expect(built.providers.tts!['babelcast-tts']!.map(t => t.providerId))
      .toEqual(['deployment:babelcast-tts-clone', 'deployment:babelcast-tts', 'openrouter']);
  });
});

describe('the speech server is not a cloud link', () => {
  it('a chain of only the speech server still gets the OpenRouter default after it', () => {
    expect(isCloudLink({ provider: 'kokoro-stream' })).toBe(false);
    expect(isCloudLink({ provider: 'pocket' })).toBe(false);
    const { routes, added } = withCloudFallback({ tts: { 'x-tts': [{ provider: 'pocket', model: 'pocket' }] } });
    expect(routes.tts!['x-tts']!.map(e => e.provider)).toEqual(['pocket', 'openrouter']);
    expect(added).toHaveLength(1);
  });

  it('the fallback probe speaks Portuguese to it ("Bom dia.") and gets audio', async () => {
    const { built } = setup();
    const link = fallbackLinks(built.chains, built.providers as never).find(l => l.providerId === 'kokoro-stream')!;
    const result = await probeLink(link, { timeoutMs: 3_000 });
    expect(result).toMatchObject({ ok: true });
    expect(seen.at(-1)).toMatchObject({ voice: 'pf_dora', input: 'Bom dia.' });
  });
});

describe('voices and languages', () => {
  it('reads the app\'s language names and ISO codes', () => {
    expect(['Portuguese', 'pt', 'pt-BR', 'PT_br', ' French '].map(languageCode)).toEqual(['pt', 'pt', 'pt', 'pt', 'fr']);
    expect([undefined, '', 'Klingon', 'xx', 42].map(languageCode)).toEqual([null, null, null, null, null]);
  });

  it('Kokoro: keeps a voice it has in that language, else the language\'s voice; no language and no Kokoro voice → none', () => {
    expect(kokoroStreamVoice('pf_dora', 'pt')).toBe('pf_dora');
    expect(kokoroStreamVoice('pf_dora', 'fr')).toBe('ff_siwis');
    expect(kokoroStreamVoice('pm_alex', 'pt')).toBe('pf_dora');
    expect(kokoroStreamVoice('pm_alex', null)).toBe('pf_dora');
    expect(kokoroStreamVoice('Ryan', 'it')).toBe('if_sara');
    expect(kokoroStreamVoice('Ryan', null)).toBeNull();
    expect(kokoroStreamVoice('Ryan', 'ja')).toBeNull();
  });

  it('Pocket: by language and the preset\'s gender, its own voices kept, its language from the voice when none is sent', () => {
    expect(pocketVoice('Ryan', 'pt')).toEqual({ voice: 'rafael', language: 'pt' });
    expect(pocketVoice('Serena', 'pt')).toEqual({ voice: 'estelle', language: 'pt' });
    expect(pocketVoice('Ryan', 'de')).toEqual({ voice: 'juergen', language: 'de' });
    expect(pocketVoice('lola', null)).toEqual({ voice: 'lola', language: 'es' });
    expect(pocketVoice('marius', 'fr')).toEqual({ voice: 'marius', language: 'fr' });
    expect(pocketVoice('Ryan', null)).toBeNull();
    expect(pocketVoice('Ryan', 'ja')).toBeNull();
  });
});
