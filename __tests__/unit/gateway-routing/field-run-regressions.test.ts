/**
 * Regressions found by the end-to-end run (gateway + fake deployments + mock palco + real audio, 2026-10-05).
 */
import { describe, expect, it, vi } from 'vitest';
import { buildServeProviders, type ServeInstances } from '../../../src/config/serve-providers';
import { isEnvPinned, loadSandboxEnv } from '../../../src/config/sandbox-env';
import { deploymentsFromEnv } from '../../../src/deployments';
import { DeploymentError } from '../../../src/deployments/controller';
import { DeploymentLLMProvider, DeploymentSTTProvider } from '../../../src/deployments/inference-providers';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { CooldownTracker } from '../../../src/gateway/providers/cloud/fallback';
import type { ChatRequest, LLMProvider, STTProvider } from '../../../src/gateway/providers/cloud/types';
import { handleAudioTranscriptions, _resetSttCache } from '../../../src/gateway/proxy/routes/audio-transcriptions';
import { handleChatCompletions } from '../../../src/gateway/proxy/routes/chat-completions';
import { handleAudioSpeech } from '../../../src/gateway/proxy/routes/audio-speech';
import type { ProxyRequest, RouteTarget } from '../../../src/gateway/proxy/types';
import { parleRoutes } from './_parle-routes';

const chatReq = (model = 'parle-llm', extra: Record<string, unknown> = {}): ProxyRequest => ({
  method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0),
  body: { model, messages: [{ role: 'user', content: 'oi' }], ...extra },
});
const fresh = () => ({ circuitBreakers: new CircuitBreakerRegistry(), cooldownTracker: new CooldownTracker() });

function llm(providerId: string, impl: (r: ChatRequest) => Promise<{ content: string; model: string; finishReason?: string }>): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  return { providerId, isConfigured: () => true, chat: vi.fn(impl) };
}

function chat(routes: Array<RouteTarget<LLMProvider>>, extra: Record<string, unknown> = {}, unavailable?: Record<string, string[]>) {
  return handleChatCompletions(chatReq('parle-llm', extra), {}, undefined, undefined, undefined, undefined, undefined,
    { chatRoutes: { 'parle-llm': routes }, ...(unavailable ? { unavailable } : {}), ...fresh() });
}

describe('1) empty LLM answers are failures; reasoning off; finish_reason passed through', () => {
  it('an empty answer (reasoning model out of tokens) moves to the next target', async () => {
    const qwen = llm('openrouter', async () => ({ content: '', model: 'qwen/qwen3.5-9b', finishReason: 'length' }));
    const gemini = llm('openrouter', async () => ({ content: 'Bom dia!', model: 'google/gemini-2.5-flash-lite', finishReason: 'stop' }));
    const res = await chat([
      { providerId: 'openrouter', provider: qwen, model: 'qwen/qwen3.5-9b' },
      { providerId: 'openrouter', provider: gemini, model: 'google/gemini-2.5-flash-lite' },
    ]);
    expect(res.status).toBe(200);
    expect((res.body as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe('Bom dia!');
    expect(res.headers).toMatchObject({
      'X-Gateway-Provider': 'openrouter:google/gemini-2.5-flash-lite',
      'X-Gateway-Fallback': 'empty',
      'X-Gateway-Fallback-From': 'openrouter:qwen/qwen3.5-9b',
    });
  });

  it('only empty answers → 503 provider_unavailable, never 200 with ""', async () => {
    const res = await chat([{ providerId: 'openrouter', provider: llm('openrouter', async () => ({ content: '', model: 'm', finishReason: 'length' })), model: 'm' }]);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain('empty answer (finish_reason: length)');
  });

  it('finish_reason from upstream is kept (length stays length)', async () => {
    const res = await chat([{ providerId: 'openrouter', provider: llm('openrouter', async () => ({ content: 'Bom', model: 'm', finishReason: 'length' })), model: 'm' }]);
    expect((res.body as { choices: Array<{ finish_reason: string }> }).choices[0].finish_reason).toBe('length');
  });

  it('extraBody (reasoning off) reaches the provider call', async () => {
    const p = llm('openrouter', async () => ({ content: 'ok', model: 'm' }));
    await chat([{ providerId: 'openrouter', provider: p, model: 'qwen/qwen3.5-9b', extraBody: { reasoning: { enabled: false } } }]);
    expect(p.chat.mock.calls[0][0].extraBody).toEqual({ reasoning: { enabled: false } });
  });

  it('the parle-llm OpenRouter targets have reasoning off and no ZDR-blocked model', () => {
    const p = { providerId: 'openrouter', isConfigured: () => true } as never;
    const instances: ServeInstances = { chat: { openrouter: p }, stt: { openrouter: p }, tts: { openrouter: p } };
    const { providers } = buildServeProviders({ instances, openrouter: { state: 'valid' }, appRoutes: parleRoutes() });
    const chain = providers.chatRoutes!['parle-llm'];
    expect(chain.map(t => t.model)).not.toContain('qwen/qwen3.7-flash');
    for (const t of chain) expect(t.extraBody).toEqual({ reasoning: { enabled: false } });
  });

  it('a 404 data-policy error from OpenRouter is a provider failure (next target, then 503), not a 404 route', async () => {
    const zdr = llm('openrouter', async () => { throw Object.assign(new Error('No endpoints found matching your data policy (ZDR)'), { status: 404 }); });
    const ok = llm('groq', async () => ({ content: 'olá', model: 'llama' }));
    const res = await chat([{ providerId: 'openrouter', provider: zdr, model: 'x' }, { providerId: 'groq', provider: ok, model: 'llama' }]);
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Fallback']).toBe('not_found');
    const only = await chat([{ providerId: 'openrouter', provider: zdr, model: 'x' }]);
    expect(only.status).toBe(503);
  });

  it('streaming: an empty stream falls back before anything is sent', async () => {
    const empty: LLMProvider = { providerId: 'openrouter', isConfigured: () => true, chat: vi.fn(), async *chatStream() { yield '__usage__:{}'; } };
    const good: LLMProvider = { providerId: 'openrouter', isConfigured: () => true, chat: vi.fn(), async *chatStream() { yield 'olá'; } };
    const res = await chat([{ providerId: 'openrouter', provider: empty, model: 'a' }, { providerId: 'openrouter', provider: good, model: 'b' }], { stream: true });
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:b', 'X-Gateway-Fallback': 'empty' });
    expect(await new Response(res.stream).text()).toContain('olá');
  });
});

describe('2) two targets of the same provider stay apart', () => {
  it('X-Gateway-Provider names the target that answered, and openrouter→openrouter is a fallback', async () => {
    const first = llm('openrouter', async () => { throw Object.assign(new Error('busy'), { status: 429 }); });
    const second = llm('openrouter', async () => ({ content: 'ok', model: 'b' }));
    const third = llm('openrouter', async () => ({ content: 'never', model: 'c' }));
    const res = await chat([
      { providerId: 'openrouter', provider: first, model: 'a' },
      { providerId: 'openrouter', provider: second, model: 'b' },
      { providerId: 'openrouter', provider: third, model: 'c' },
    ]);
    expect(res.headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:b', 'X-Gateway-Fallback': 'rate_limited', 'X-Gateway-Fallback-From': 'openrouter:a' });
    expect(third.chat).not.toHaveBeenCalled();
  });
});

function fakeController(opts: { cold?: boolean; status?: string; fetchHang?: boolean } = {}) {
  const lease = { machine: { id: 'm1', ip: '10.0.0.9' }, token: 't', done: vi.fn() };
  return {
    lease,
    get: vi.fn(() => ({ status: opts.status ?? 'ready' }) as never),
    wake: vi.fn(),
    acquire: vi.fn(async () => {
      if (opts.cold) throw new DeploymentError(503, 'replicas are starting', 30);
      return lease as never;
    }),
  };
}

describe('3) STT cache answers say so and still warm the deployment', () => {
  it('X-Gateway-Provider: cache, and a cold deployment gets a wake', async () => {
    _resetSttCache();
    const ctl = fakeController({ cold: true, status: 'scaled-to-zero' });
    const or: STTProvider = { providerId: 'openrouter', isConfigured: () => true, getModels: () => [], transcribe: vi.fn(async () => ({ text: 'bom dia' })) };
    const routes = { 'parle-stt': [
      { providerId: 'deployment:parle-speech', provider: new DeploymentSTTProvider(ctl, 'parle-speech') as STTProvider },
      { providerId: 'openrouter', provider: or, model: 'w' },
    ] };
    const req = (): ProxyRequest => ({ method: 'POST', url: '/v1/audio/transcriptions', headers: {}, rawBody: Buffer.from('RIFF-same-audio'), body: { model: 'parle-stt' } });
    await handleAudioTranscriptions(req(), routes, undefined, new CircuitBreakerRegistry());
    ctl.wake.mockClear();
    const hit = await handleAudioTranscriptions(req(), routes, undefined, new CircuitBreakerRegistry());
    expect(hit.headers).toMatchObject({ 'X-Cache': 'HIT', 'X-Gateway-Provider': 'cache' });
    expect(ctl.wake).toHaveBeenCalledWith('parle-speech');
    expect(or.transcribe).toHaveBeenCalledTimes(1);
  });
});

describe('4) a replica timeout is labelled timeout and the replica call is aborted', () => {
  it('aborts the replica fetch, releases the lease, and falls back with X-Gateway-Fallback: timeout', async () => {
    const ctl = fakeController();
    let aborted = false;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    }));
    const dep = new DeploymentLLMProvider(ctl, 'parle-speech', { fetchImpl: fetchImpl as never });
    const or = llm('openrouter', async () => ({ content: 'ok', model: 'm' }));
    const t0 = Date.now();
    const res = await chat([
      { providerId: 'deployment:parle-speech', provider: dep, model: 'q', timeoutMs: 50 },
      { providerId: 'openrouter', provider: or, model: 'm' },
    ]);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'X-Gateway-Fallback': 'timeout', 'X-Gateway-Fallback-From': 'deployment:parle-speech' });
    expect(aborted).toBe(true);
    // The route's attempt timeout reaches the lease as `timeout` (busy), not as a connection failure (QA 2026-10-07).
    expect(ctl.lease.done).toHaveBeenCalledWith('timeout');
  });

  it('deployment targets get a short timeout (DEPLOYMENT_TIMEOUT_MS)', () => {
    const p = { providerId: 'x', isConfigured: () => true } as never;
    const instances: ServeInstances = { chat: { openrouter: p }, stt: { openrouter: p }, tts: { openrouter: p } };
    const dep = vi.fn(() => p);
    const { providers } = buildServeProviders({ instances, openrouter: { state: 'valid' }, deploymentProvider: dep, env: { DEPLOYMENT_TIMEOUT_MS: '4000' }, appRoutes: parleRoutes() });
    expect(providers.tts!['parle-tts'][0]).toMatchObject({ providerId: 'deployment:parle-qwen-tts', timeoutMs: 4000 });
    expect(providers.tts!['parle-tts'][1].timeoutMs).toBeUndefined();
  });
});

describe('5) the 503 names the fallback key even when the deployment is still in the chain', () => {
  it('buildServeProviders keeps the reasons of dropped entries of a mounted chain', () => {
    const p = { providerId: 'x', isConfigured: () => false } as never;
    const instances: ServeInstances = { chat: { openrouter: p }, stt: { openrouter: p }, tts: { openrouter: p } };
    const { providers, summary } = buildServeProviders({ instances, openrouter: { state: 'missing' }, deploymentProvider: () => ({ providerId: 'self-hosted', isConfigured: () => true }) as never, appRoutes: parleRoutes() });
    expect(providers.tts!['parle-tts']).toHaveLength(1);
    expect(providers.unavailable!.tts!['parle-tts']).toEqual(['openrouter: OPENROUTER_API_KEY is not set']);
    expect((summary.unavailable as { tts: string[] }).tts).not.toContain('parle-tts');
  });

  it('chat, STT and TTS 503s carry the deployment failure AND the missing fallback key', async () => {
    const missing = { 'parle-llm': ['openrouter: OPENROUTER_API_KEY is not set'] };
    const res = await chat([{ providerId: 'deployment:parle-speech', provider: new DeploymentLLMProvider(fakeController({ cold: true }), 'parle-speech'), model: 'q' }], {}, missing);
    expect(res.status).toBe(503);
    const text = JSON.stringify(res.body);
    expect(text).toContain('deployment:parle-speech failed (HTTP 503)');
    expect(text).toContain('OPENROUTER_API_KEY is not set');

    const tts = await handleAudioSpeech(
      { method: 'POST', url: '/v1/audio/speech', headers: {}, rawBody: Buffer.alloc(0), body: { model: 'parle-tts', input: 'oi', voice: 'v' } },
      { 'parle-tts': [{ providerId: 'deployment:parle-qwen-tts', provider: { providerId: 'self-hosted', isConfigured: () => true, getModels: () => [], getVoices: () => [], synthesizeStream: vi.fn(), synthesize: vi.fn(async () => { throw Object.assign(new Error('boom'), { status: 500 }); }) } }] },
      { 'parle-tts': ['openrouter: OPENROUTER_API_KEY is not set'] }, new CircuitBreakerRegistry(),
    );
    expect(tts.status).toBe(503);
    expect(JSON.stringify(tts.body)).toContain('OPENROUTER_API_KEY is not set');
  });
});

describe('deployments namespace safety', () => {
  it('the palco never sets DEPLOYMENTS_NAMESPACE nor RAILWAY_*', async () => {
    const env: Record<string, string | undefined> = { SANDBOX_TOKEN: 'tok' };
    const fetchImpl = vi.fn(async () => Response.json({ DEPLOYMENTS_NAMESPACE: 'default', RAILWAY_PROJECT_ID: 'p', SCW_SECRET_KEY: 's' }));
    await loadSandboxEnv(env, { fetchImpl: fetchImpl as never });
    expect(env.DEPLOYMENTS_NAMESPACE).toBeUndefined();
    expect(env.RAILWAY_PROJECT_ID).toBeUndefined();
    expect(env.SCW_SECRET_KEY).toBe('s');
    expect(isEnvPinned('DEPLOYMENTS_NAMESPACE')).toBe(true);
  });

  it('outside Railway, deployments need an explicit namespace', () => {
    const log = vi.fn();
    const opts = { userOf: () => null, log };
    expect(deploymentsFromEnv({ SCW_SECRET_KEY: 's' }, opts)).toBeNull();
    expect(log.mock.calls[0][0]).toContain('DEPLOYMENTS_NAMESPACE');
    const onRailway = deploymentsFromEnv({ SCW_SECRET_KEY: 's', RAILWAY_ENVIRONMENT_ID: 'e', DEPLOYMENTS_STATE_DIR: '/tmp/aigw-ns-test' }, opts);
    expect(onRailway?.controller.namespace).toBe('default');
    const explicit = deploymentsFromEnv({ SCW_SECRET_KEY: 's', DEPLOYMENTS_NAMESPACE: 'dev-me', DEPLOYMENTS_STATE_DIR: '/tmp/aigw-ns-test' }, opts);
    expect(explicit?.controller.namespace).toBe('dev-me');
  });
});

describe('openai-compat LLM sends extraBody and returns finish_reason', () => {
  it('passes reasoning:{enabled:false} in the body and reads finish_reason', async () => {
    const { OpenAICompatLLMProvider } = await import('../../../src/gateway/providers/cloud/openai-compat/openai-compat-llm');
    const provider = new OpenAICompatLLMProvider({ providerId: 'openrouter', baseURL: 'https://example.invalid/v1', envKey: 'UNUSED_TEST_KEY' }).withApiKey('k');
    const create = vi.fn(async () => ({ model: 'm', choices: [{ message: { content: 'oi' }, finish_reason: 'length' }] }));
    (provider as unknown as { client: { chat: { completions: { create: typeof create } } } }).client = { chat: { completions: { create } } };
    const r = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], extraBody: { reasoning: { enabled: false } } });
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ model: 'm', reasoning: { enabled: false } });
    expect(r.finishReason).toBe('length');
  });
});
