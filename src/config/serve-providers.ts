/**
 * Provider wiring of the production entry point (`serve.ts`).
 *
 * Rules:
 *   - A provider is mounted only when it is configured (its key is set; for OpenRouter, the key is not rejected by
 *     `/api/v1/key`). A model with no configured provider is NOT listed in /v1/models and answers
 *     503 `provider_unavailable` naming the missing key — never a 500 from deep inside a provider.
 *   - Every model has an ordered chain across DIFFERENT providers. Default order for cloud models:
 *     Groq → OpenRouter (equivalent id) → other keyed providers (STT: OpenAI, Fireworks, Deepgram).
 *   - `MODEL_ROUTES` (JSON) adds or replaces chains — this is where a self-hosted deployment becomes the primary:
 *       {"chat": {"parle-llm": ["deployment:parle-speech:Qwen/Qwen3.5-9B", "openrouter:qwen/qwen3.5-9b"]},
 *        "stt":  {"whisper-large-v3": ["deployment:parle-speech", "openrouter:openai/whisper-large-v3", "groq"]},
 *        "tts":  {"qwen3-tts": ["deployment:parle-qwen-tts:Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
 *                              {"provider": "openrouter", "model": "qwen/qwen-audio-3.0-tts-flash", "voice": "Cherry"}]}}
 *     Entry: "provider" | "provider:upstreamModel" | "deployment:<name>[:upstreamModel]" |
 *            {provider, model?, voice?, deployment?}. The special chat key "*" replaces the generic chat fallback.
 */

import type { LLMProvider, STTProvider, TTSProvider } from '../gateway/providers/cloud/types';
import type { ChatDynamicRoute, DynamicModelCatalog, ProviderMapping, RouteTarget } from '../gateway/proxy/types';
import { notConfiguredReason, PROVIDER_KEY_ENV, redactSecrets } from '../gateway/proxy/provider-routing';
import { hasCloudProbe, probeAllCloudProviders, probeCloudProvider } from '../gateway/providers/cloud/cloud-health';
import type { CircuitBreakerRegistry } from '../gateway/providers/cloud/circuit-breaker';

type Stage = 'chat' | 'stt' | 'tts';
type StageProvider<S extends Stage> = S extends 'chat' ? LLMProvider : S extends 'stt' ? STTProvider : TTSProvider;

/** Provider instances by id, per stage. Only these ids can appear in a chain. */
export interface ServeInstances {
  chat: Record<string, LLMProvider>;
  stt: Record<string, STTProvider>;
  tts: Record<string, TTSProvider>;
}

/** Groq chat models → OpenRouter id of the same weights (null = no equivalent, Groq only). */
export const GROQ_CHAT_EQUIVALENTS: Record<string, string | null> = {
  'llama-3.3-70b-versatile': 'meta-llama/llama-3.3-70b-instruct',
  'llama-3.1-8b-instant': 'meta-llama/llama-3.1-8b-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct': 'meta-llama/llama-4-scout',
  'openai/gpt-oss-120b': 'openai/gpt-oss-120b',
  'openai/gpt-oss-20b': 'openai/gpt-oss-20b',
  'qwen/qwen3-32b': 'qwen/qwen3-32b',
  'groq/compound': null,
};

/** Z.AI GLM models that OpenRouter also serves (as z-ai/<id>). */
const ZAI_ON_OPENROUTER = new Set(['glm-4.5', 'glm-4.5-air', 'glm-4.5v', 'glm-4.6', 'glm-4.7']);

/** STT models of the default chain and their id on each provider. */
const STT_CHAINS: Record<string, Array<[string, string]>> = {
  'whisper-large-v3': [['groq', 'whisper-large-v3'], ['openrouter', 'openai/whisper-large-v3'], ['openai', 'whisper-1'],
    ['fireworks', 'whisper-v3'], ['deepgram', 'nova-3']],
  'whisper-large-v3-turbo': [['groq', 'whisper-large-v3-turbo'], ['openrouter', 'openai/whisper-large-v3-turbo'],
    ['openai', 'whisper-1'], ['fireworks', 'whisper-v3'], ['deepgram', 'nova-3']],
};

/** Groq Orpheus voices exist only on Groq. PlayAI TTS was retired by Groq and is not offered any more. */
const TTS_CHAINS: Record<string, Array<[string, string]>> = {
  'canopylabs/orpheus-v1-english': [['groq', 'canopylabs/orpheus-v1-english']],
  'canopylabs/orpheus-arabic-saudi': [['groq', 'canopylabs/orpheus-arabic-saudi']],
};

/**
 * Gateway aliases the parle client calls. The self-hosted Scaleway deployment is the primary; OpenRouter is the
 * fallback of every stage (same models the parle client used directly, see parle core/lang/speech-config.ts);
 * Groq is an extra fallback when it has a key. Deployment names come from SPEECH_DEPLOYMENT (STT + LLM, default
 * parle-speech) and TTS_DEPLOYMENT (default parle-qwen-tts). MODEL_ROUTES replaces any of these per model.
 */
export function defaultAliasRoutes(env: Record<string, string | undefined>): Record<Stage, Record<string, RouteEntrySpec[]>> {
  const speech = env.SPEECH_DEPLOYMENT?.trim() || 'parle-speech';
  const tts = env.TTS_DEPLOYMENT?.trim() || env.QWEN_TTS_DEPLOYMENT?.trim() || 'parle-qwen-tts';
  const ttsChain: RouteEntrySpec[] = [
    { provider: 'deployment', deployment: tts, model: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice' },
    // Qwen3-TTS voices do not exist on Kokoro: the fallback uses its own voice (request `fallback_voice` overrides).
    { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'pf_dora' },
  ];
  return {
    stt: {
      'parle-stt': [
        { provider: 'deployment', deployment: speech, model: 'whisper-large-v3-turbo' },
        { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' },
        { provider: 'groq', model: 'whisper-large-v3-turbo' },
      ],
    },
    chat: {
      'parle-llm': [
        { provider: 'deployment', deployment: speech, model: 'qwen3.5-9b' },
        { provider: 'openrouter', model: 'qwen/qwen3.5-9b' },
        { provider: 'openrouter', model: 'qwen/qwen3.7-flash' },
      ],
    },
    tts: { 'parle-tts': ttsChain, 'qwen/qwen3-tts': ttsChain },
  };
}

export type OpenRouterKeyState = { state: 'missing' | 'valid' | 'invalid' | 'unknown'; detail?: string };

/**
 * Checks OPENROUTER_API_KEY against `/api/v1/key` (401 for a revoked key — `/models` is public and proves nothing).
 * Never throws and never blocks the boot for long: a timeout/network error is "unknown" and the key is still used.
 */
export async function checkOpenRouterKey(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4_000,
): Promise<OpenRouterKeyState> {
  const key = env.OPENROUTER_API_KEY;
  if (!key) return { state: 'missing' };
  const probe = await probeCloudProvider('openrouter', key, timeoutMs, fetchImpl);
  if (probe.ok) return { state: 'valid' };
  if (probe.error === 'HTTP 401' || probe.error === 'HTTP 403') return { state: 'invalid', detail: probe.error };
  return { state: 'unknown', detail: redactSecrets(probe.error ?? 'unreachable') };
}

export interface RouteEntrySpec { provider: string; model?: string; voice?: string; deployment?: string }
export type ModelRoutesSpec = Partial<Record<Stage, Record<string, RouteEntrySpec[]>>>;

function parseEntry(raw: unknown): RouteEntrySpec | null {
  if (typeof raw === 'string') {
    const [provider, ...rest] = raw.split(':');
    if (!provider) return null;
    if (provider === 'deployment') {
      const [deployment, ...model] = rest;
      return deployment ? { provider, deployment, ...(model.length ? { model: model.join(':') } : {}) } : null;
    }
    return { provider, ...(rest.length ? { model: rest.join(':') } : {}) };
  }
  if (raw && typeof raw === 'object' && typeof (raw as RouteEntrySpec).provider === 'string') {
    const e = raw as RouteEntrySpec;
    return {
      provider: e.provider,
      ...(typeof e.model === 'string' ? { model: e.model } : {}),
      ...(typeof e.voice === 'string' ? { voice: e.voice } : {}),
      ...(typeof e.deployment === 'string' ? { deployment: e.deployment } : {}),
    };
  }
  return null;
}

/** Parses MODEL_ROUTES. Invalid JSON or entries are reported in `errors` and skipped (the boot goes on). */
export function parseModelRoutes(raw: string | undefined): { routes: ModelRoutesSpec; errors: string[] } {
  const routes: ModelRoutesSpec = {};
  const errors: string[] = [];
  if (!raw?.trim()) return { routes, errors };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { routes, errors: ['MODEL_ROUTES is not valid JSON'] }; }
  if (!parsed || typeof parsed !== 'object') return { routes, errors: ['MODEL_ROUTES must be a JSON object'] };
  for (const stage of ['chat', 'stt', 'tts'] as const) {
    const byModel = (parsed as Record<string, unknown>)[stage];
    if (byModel === undefined) continue;
    if (!byModel || typeof byModel !== 'object') { errors.push(`MODEL_ROUTES.${stage} must be an object`); continue; }
    for (const [model, list] of Object.entries(byModel as Record<string, unknown>)) {
      const entries = (Array.isArray(list) ? list : [list]).map(parseEntry);
      if (entries.some(e => e === null)) errors.push(`MODEL_ROUTES.${stage}.${model}: invalid entry skipped`);
      const valid = entries.filter((e): e is RouteEntrySpec => e !== null);
      if (valid.length) (routes[stage] ??= {})[model] = valid;
    }
  }
  return { routes, errors };
}

export interface BuildServeProvidersOptions {
  instances: ServeInstances;
  /** Read for the deployment names of the default aliases (SPEECH_DEPLOYMENT, TTS_DEPLOYMENT). */
  env?: Record<string, string | undefined>;
  openrouter: OpenRouterKeyState;
  /** Returns a provider backed by deployment `name`, or null when the deployments service is off. */
  deploymentProvider?: (stage: Stage, name: string) => StageProvider<Stage> | null;
  modelRoutes?: ModelRoutesSpec;
  /** Static Z.AI model ids (from ZAI_LLM_MODELS). */
  zaiModels?: string[];
  /** OpenRouter catalog lister for /v1/models (only used when the key is valid). */
  listOpenRouterModels?: () => Promise<string[]>;
}

export interface ServeProvidersResult {
  providers: Omit<ProviderMapping, 'image'>;
  summary: Record<string, unknown>;
}

const OPENROUTER_PASSTHROUGH = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i;

export function buildServeProviders(opts: BuildServeProvidersOptions): ServeProvidersResult {
  const { instances, openrouter } = opts;
  const openrouterUsable = openrouter.state === 'valid' || openrouter.state === 'unknown';

  const reasonFor = (providerId: string): string => {
    if (providerId === 'openrouter' && openrouter.state === 'invalid') {
      return `openrouter: OPENROUTER_API_KEY was rejected by OpenRouter (${openrouter.detail ?? 'HTTP 401'})`;
    }
    return notConfiguredReason(providerId);
  };

  /** Resolves one entry to a mounted target, or a reason why it cannot be mounted. */
  function resolve<S extends Stage>(stage: S, gatewayModel: string, e: RouteEntrySpec): RouteTarget<StageProvider<S>> | string {
    if (e.provider === 'deployment') {
      const name = e.deployment ?? '';
      const label = `deployment:${name}`;
      const provider = opts.deploymentProvider?.(stage, name) as StageProvider<S> | null | undefined;
      if (!provider) return `${label}: deployments are disabled on this gateway (SCW_SECRET_KEY is not set)`;
      // Mounted even if the deployment does not exist yet: it may be created later through /v1/deployments.
      // Until then selectTargets skips it per request and /v1/models does not list a model served only by it.
      return { providerId: label, provider, model: e.model ?? gatewayModel, ...(e.voice ? { voice: e.voice } : {}) };
    }
    const provider = (instances[stage] as Record<string, StageProvider<S>>)[e.provider];
    if (!provider) return `${e.provider}: no ${stage} provider with this id`;
    const usable = e.provider === 'openrouter' ? openrouterUsable : provider.isConfigured();
    if (!usable) return reasonFor(e.provider);
    return { providerId: e.provider, provider, model: e.model ?? gatewayModel, ...(e.voice ? { voice: e.voice } : {}) };
  }

  const unavailable: Record<Stage, Record<string, string[]>> = { chat: {}, stt: {}, tts: {} };
  function chainFor<S extends Stage>(stage: S, model: string, entries: RouteEntrySpec[]): Array<RouteTarget<StageProvider<S>>> {
    const targets: Array<RouteTarget<StageProvider<S>>> = [];
    const reasons: string[] = [];
    for (const e of entries) {
      const r = resolve(stage, model, e);
      if (typeof r !== 'string') targets.push(r);
      else if (!reasons.includes(r)) reasons.push(r);
    }
    if (targets.length === 0) (unavailable[stage as Stage] as Record<string, string[]>)[model] = reasons;
    return targets;
  }

  // Default chains, then MODEL_ROUTES on top (same model = replaced).
  const specs: Record<Stage, Record<string, RouteEntrySpec[]>> = { chat: {}, stt: {}, tts: {} };
  for (const [model, eq] of Object.entries(GROQ_CHAT_EQUIVALENTS)) {
    specs.chat[model] = [{ provider: 'groq', model }, ...(eq ? [{ provider: 'openrouter', model: eq }] : [])];
  }
  for (const model of opts.zaiModels ?? []) {
    specs.chat[model] = [{ provider: 'zai', model }, ...(ZAI_ON_OPENROUTER.has(model) ? [{ provider: 'openrouter', model: `z-ai/${model}` }] : [])];
  }
  for (const [model, chain] of Object.entries(STT_CHAINS)) specs.stt[model] = chain.map(([provider, m]) => ({ provider, model: m }));
  for (const [model, chain] of Object.entries(TTS_CHAINS)) specs.tts[model] = chain.map(([provider, m]) => ({ provider, model: m }));
  const aliases = defaultAliasRoutes(opts.env ?? {});
  for (const stage of ['chat', 'stt', 'tts'] as const) Object.assign(specs[stage], aliases[stage]);
  for (const stage of ['chat', 'stt', 'tts'] as const) Object.assign(specs[stage], opts.modelRoutes?.[stage] ?? {});

  const genericFallback = specs.chat['*'] ?? [
    { provider: 'groq', model: 'llama-3.3-70b-versatile' }, { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' },
  ];
  delete specs.chat['*'];

  const chatRoutes: Record<string, Array<RouteTarget<LLMProvider>>> = {};
  for (const [model, entries] of Object.entries(specs.chat)) {
    const chain = chainFor('chat', model, entries);
    if (chain.length) chatRoutes[model] = chain;
  }
  const stt: Record<string, Array<RouteTarget<STTProvider>>> = {};
  for (const [model, entries] of Object.entries(specs.stt)) {
    const chain = chainFor('stt', model, entries);
    if (chain.length) stt[model] = chain;
  }
  const tts: Record<string, Array<RouteTarget<TTSProvider>>> = {};
  for (const [model, entries] of Object.entries(specs.tts)) {
    const chain = chainFor('tts', model, entries);
    if (chain.length) tts[model] = chain;
  }
  const chatFallbackChain = genericFallback
    .map(e => resolve('chat', e.model ?? '', e))
    .filter((t): t is RouteTarget<LLMProvider> => typeof t !== 'string')
    .map(t => ({ providerId: t.providerId, model: t.model ?? '', provider: t.provider }));

  const openrouterLLM = instances.chat.openrouter;
  const chatDynamicRoutes: ChatDynamicRoute[] = openrouterUsable && openrouterLLM ? [{
    providerId: 'openrouter',
    provider: openrouterLLM,
    acceptsModel: (model) => OPENROUTER_PASSTHROUGH.test(model),
    upstreamModel: (model) => (model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model),
  }] : [];
  const dynamicModelCatalogs: DynamicModelCatalog[] = openrouter.state === 'valid' && opts.listOpenRouterModels
    ? [{ providerId: 'openrouter', listModels: opts.listOpenRouterModels }] : [];

  return {
    providers: {
      chat: {},
      chatRoutes,
      chatFallbackChain,
      ...(chatDynamicRoutes.length ? { chatDynamicRoutes } : {}),
      ...(dynamicModelCatalogs.length ? { dynamicModelCatalogs } : {}),
      stt,
      tts,
      unavailable,
    },
    summary: {
      openrouterKey: openrouter.state,
      openrouterRouting: chatDynamicRoutes.length ? 'dynamic-passthrough' : 'disabled',
      chatModels: Object.keys(chatRoutes),
      sttModels: Object.keys(stt),
      ttsModels: Object.keys(tts),
      chatFallback: chatFallbackChain.map(e => `${e.providerId}:${e.model}`),
      unavailable: Object.fromEntries((['chat', 'stt', 'tts'] as const).map(s => [s, Object.keys(unavailable[s])])),
    },
  };
}

export interface DeepHealthDeps {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  breakers: CircuitBreakerRegistry;
  providers: Pick<ProviderMapping, 'chatRoutes' | 'stt' | 'tts' | 'unavailable'>;
  deployments?: {
    health(): { deployments: number; replicas: number; listError: string | null };
    list(): Array<{ name: string; status: string; replicas: Array<{ phase: string }>; lastError: string | null }>;
  } | null;
}

/** `GET /health?deep=1` body: key presence + live probe per provider, circuits, deployments. Never contains a key. */
export async function deepHealthReport(deps: DeepHealthDeps): Promise<{ status: number; body: unknown }> {
  const keys: Record<string, string> = {};
  const providers: Array<Record<string, unknown>> = [];
  for (const [provider, envName] of Object.entries(PROVIDER_KEY_ENV)) {
    const value = deps.env[envName];
    if (!value) providers.push({ provider, configured: false, ok: false, error: `${envName} is not set` });
    else if (!hasCloudProbe(provider)) providers.push({ provider, configured: true, ok: null, error: 'no probe for this provider' });
    else keys[provider] = value;
  }
  const probes = await probeAllCloudProviders(keys, deps.timeoutMs ?? 5_000, deps.fetchImpl ?? fetch);
  for (const p of probes) {
    providers.push({ provider: p.provider, configured: true, ok: p.ok, latencyMs: p.latencyMs, ...(p.error ? { error: redactSecrets(p.error, deps.env) } : {}) });
  }
  const failing = probes.filter(p => !p.ok).map(p => p.provider);
  const deployments = deps.deployments ? {
    ...deps.deployments.health(),
    items: deps.deployments.list().map(d => ({
      name: d.name, status: d.status, replicas: d.replicas.length,
      ready: d.replicas.filter(r => r.phase === 'ready').length, lastError: d.lastError,
    })),
  } : null;
  return {
    status: 200,
    body: {
      status: failing.length ? 'degraded' : 'ok',
      providers,
      circuits: deps.breakers.allStats(),
      models: {
        chat: Object.keys(deps.providers.chatRoutes ?? {}),
        stt: Object.keys(deps.providers.stt ?? {}),
        tts: Object.keys(deps.providers.tts ?? {}),
        unavailable: deps.providers.unavailable ?? {},
      },
      deployments,
    },
  };
}

/**
 * Swaps the contents of the live provider mapping in place (the proxy holds this object), so a key reload
 * re-mounts providers without restarting the server. Keys absent from `next` are removed.
 */
export function replaceProviderMapping(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
  Object.assign(target, next);
}

/** Provider ids whose key is among `names` (e.g. ["OPENROUTER_API_KEY"] → ["openrouter"]). */
export function providersOfKeys(names: string[]): string[] {
  return Object.entries(PROVIDER_KEY_ENV).filter(([, env]) => names.includes(env)).map(([id]) => id);
}
