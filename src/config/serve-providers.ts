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
 *        "tts":  {"qwen3-tts": ["deployment:parle-qwen-tts:Qwen/Qwen3-TTS-12Hz-0.6B-Base",
 *                              {"provider": "openrouter", "model": "qwen/qwen-audio-3.0-tts-flash", "voice": "Cherry"}]}}
 *     Entry: "provider" | "provider:upstreamModel" | "deployment:<name>[:upstreamModel]" |
 *            {provider, model?, voice?, deployment?}. The special chat key "*" replaces the generic chat fallback.
 */

import type { LLMProvider, STTProvider, TTSProvider } from '../gateway/providers/cloud/types';
import type { ChatDynamicRoute, DynamicModelCatalog, ProviderMapping, RouteTarget } from '../gateway/proxy/types';
import { notConfiguredReason, PROVIDER_KEY_ENV, redactSecrets } from '../gateway/proxy/provider-routing';
import { hasCloudProbe, probeAllCloudProviders, probeCloudProvider } from '../gateway/providers/cloud/cloud-health';
import type { CircuitBreakerRegistry } from '../gateway/providers/cloud/circuit-breaker';
import { accountPolicyGuards, type AccountPolicyGuards } from '../gateway/proxy/account-policy-guard';
import { voiceForGender, type VoiceByGender, type VoiceGender } from './tts-fallback-voices';
import type { ChainLinkSpec } from './stage-chains';

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
 * Time a deployment target gets to send its FIRST BYTE before the chain moves on, per stage. Overrides:
 * DEPLOYMENT_<STAGE>_TIMEOUT_MS (STT, CHAT, TTS), else DEPLOYMENT_TIMEOUT_MS for all stages.
 * Sized so deployment + fallback fit the stage budget (8 s, `GATEWAY_<STAGE>_BUDGET_MS`) below parle's deadlines.
 */
export const DEPLOYMENT_FIRST_BYTE_MS: Record<Stage, number> = { stt: 4_000, chat: 4_000, tts: 3_000 };

/** After this long without an answer from a deployment, the fallback starts in parallel (DEPLOYMENT_HEDGE_MS; 0 = off). */
export const DEPLOYMENT_HEDGE_MS = 1_500;

function positiveMs(value: string | undefined): number | undefined {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
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

export interface RouteEntrySpec {
  provider: string;
  model?: string;
  voice?: string;
  /** TTS only: this entry keeps its own voice even when the request sends `fallback_voice`. */
  fixedVoice?: boolean;
  deployment?: string;
  /**
   * Deployment entries only — **one-GPU mode**: when `deployment` is not registered on this gateway and this one is,
   * the entry goes to this one (e.g. TTS declared on a dedicated `x-tts` machine, served by the `x-speech` machine
   * that runs every stage). A registered `deployment` always wins; with neither registered the entry keeps `deployment`.
   */
  oneGpuDeployment?: string;
  /** Chat only: provider-specific body fields (e.g. `{ "reasoning": { "enabled": false } }`). */
  extraBody?: Record<string, unknown>;
  /** TTS only: stock voice by the gender of the requested voice (`tts-fallback-voices.ts`). */
  voices?: VoiceByGender;
  /** TTS only, with `voices`: the app's voice ids → gender (checked before the `xx-f-`/`xx-m-` slug pattern). */
  voiceGenders?: Record<string, VoiceGender>;
  /** TTS only, with `voices`: the request's `fallback_voice` wins over the gender table. */
  preferFallbackVoice?: boolean;
  /** TTS only: a refusal by the account's data policy (ZDR) takes this target out for a while (`account-policy-guard.ts`). */
  accountPolicyGuard?: boolean;
}
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
      ...(e.fixedVoice === true ? { fixedVoice: true } : {}),
      ...(typeof e.deployment === 'string' ? { deployment: e.deployment } : {}),
      ...(typeof e.oneGpuDeployment === 'string' && e.oneGpuDeployment ? { oneGpuDeployment: e.oneGpuDeployment } : {}),
      ...(e.extraBody && typeof e.extraBody === 'object' && !Array.isArray(e.extraBody) ? { extraBody: e.extraBody } : {}),
      ...(e.voices && typeof e.voices.feminine === 'string' && typeof e.voices.masculine === 'string'
        ? { voices: { feminine: e.voices.feminine, masculine: e.voices.masculine } } : {}),
      ...(isVoiceGenders(e.voiceGenders) ? { voiceGenders: e.voiceGenders } : {}),
      ...(e.preferFallbackVoice === true ? { preferFallbackVoice: true } : {}),
      ...(e.accountPolicyGuard === true ? { accountPolicyGuard: true } : {}),
    };
  }
  return null;
}

function isVoiceGenders(v: unknown): v is Record<string, VoiceGender> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v as Record<string, unknown>).every(g => g === 'feminine' || g === 'masculine');
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
  /** Read for the deployment first-byte timeouts and hedge (DEPLOYMENT_*_TIMEOUT_MS, DEPLOYMENT_HEDGE_MS). */
  env?: Record<string, string | undefined>;
  openrouter: OpenRouterKeyState;
  /** Returns a provider backed by deployment `name`, or null when the deployments service is off. */
  deploymentProvider?: (stage: Stage, name: string) => StageProvider<Stage> | null;
  modelRoutes?: ModelRoutesSpec;
  /** Every app's own aliases (`PUT /v1/apps/:app/routes`), merged; MODEL_ROUTES wins over them. */
  appRoutes?: ModelRoutesSpec;
  /** Static Z.AI model ids (from ZAI_LLM_MODELS). */
  zaiModels?: string[];
  /** OpenRouter catalog lister for /v1/models (only used when the key is valid). */
  listOpenRouterModels?: () => Promise<string[]>;
  /** Whether deployment `name` is registered on this gateway (resolves `oneGpuDeployment`). Absent = none is. */
  deploymentExists?: (name: string) => boolean;
  /** Account-policy guards (default: the process-wide registry, kept across remounts). */
  policyGuards?: AccountPolicyGuards;
}

export interface ServeProvidersResult {
  providers: Omit<ProviderMapping, 'image'>;
  summary: Record<string, unknown>;
  /** Every link of the app alias chains (`PUT /v1/apps/:app/routes`) and MODEL_ROUTES models, mounted or not. */
  chains: Record<Stage, Record<string, ChainLinkSpec[]>>;
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

  const env = opts.env ?? {};
  const deploymentTimeoutMs = (stage: Stage) =>
    positiveMs(env[`DEPLOYMENT_${stage.toUpperCase()}_TIMEOUT_MS`]) || positiveMs(env.DEPLOYMENT_TIMEOUT_MS) || DEPLOYMENT_FIRST_BYTE_MS[stage];
  const hedgeMs = positiveMs(env.DEPLOYMENT_HEDGE_MS) ?? DEPLOYMENT_HEDGE_MS;
  const guards = opts.policyGuards ?? accountPolicyGuards;
  const extras = (e: RouteEntrySpec) => ({
    ...(e.voice ? { voice: e.voice } : {}), ...(e.fixedVoice ? { fixedVoice: true } : {}), ...(e.extraBody ? { extraBody: e.extraBody } : {}),
    ...(e.voices ? { voiceFor: voiceForGender(e.voices, { preferFallbackVoice: e.preferFallbackVoice, genders: e.voiceGenders }) } : {}),
  });

  const exists = opts.deploymentExists ?? (() => false);
  const oneGpu: string[] = [];
  /** Deployment an entry goes to: its own, or its `oneGpuDeployment` while only that one is registered. */
  const deploymentOf = (e: RouteEntrySpec): string => {
    const own = e.deployment ?? '';
    return e.oneGpuDeployment && !exists(own) && exists(e.oneGpuDeployment) ? e.oneGpuDeployment : own;
  };

  /** Resolves one entry to a mounted target, or a reason why it cannot be mounted. */
  function resolve<S extends Stage>(stage: S, gatewayModel: string, e: RouteEntrySpec): RouteTarget<StageProvider<S>> | string {
    if (e.provider === 'deployment') {
      const name = deploymentOf(e);
      if (name !== (e.deployment ?? '')) oneGpu.push(`${stage} ${gatewayModel}: ${e.deployment} → ${name}`);
      const label = `deployment:${name}`;
      const provider = opts.deploymentProvider?.(stage, name) as StageProvider<S> | null | undefined;
      if (!provider) return `${label}: deployments are disabled on this gateway (SCW_SECRET_KEY is not set)`;
      // Mounted even if the deployment does not exist yet: it may be created later through /v1/deployments.
      // Until then selectTargets skips it per request and /v1/models does not list a model served only by it.
      return {
        ...extras(e), providerId: label, provider, model: e.model ?? gatewayModel,
        timeoutMs: deploymentTimeoutMs(stage), ...(hedgeMs > 0 ? { hedgeAfterMs: hedgeMs } : {}),
      };
    }
    const provider = (instances[stage] as Record<string, StageProvider<S>>)[e.provider];
    if (!provider) return `${e.provider}: no ${stage} provider with this id`;
    const usable = e.provider === 'openrouter' ? openrouterUsable : provider.isConfigured();
    if (!usable) return reasonFor(e.provider);
    const model = e.model ?? gatewayModel;
    if (e.accountPolicyGuard && stage === 'tts') {
      const guard = guards.get(e.provider, model);
      return {
        ...extras(e), providerId: e.provider, model, unavailableNow: () => guard.reason(),
        provider: guard.wrapTTS(provider as TTSProvider) as StageProvider<S>,
      };
    }
    return { ...extras(e), providerId: e.provider, provider, model };
  }

  const unavailable: Record<Stage, Record<string, string[]>> = { chat: {}, stt: {}, tts: {} };
  const chains: Record<Stage, Record<string, ChainLinkSpec[]>> = { chat: {}, stt: {}, tts: {} };
  let described: Record<Stage, Set<string>> = { chat: new Set(), stt: new Set(), tts: new Set() };
  function chainFor<S extends Stage>(stage: S, model: string, entries: RouteEntrySpec[]): Array<RouteTarget<StageProvider<S>>> {
    const targets: Array<RouteTarget<StageProvider<S>>> = [];
    const reasons: string[] = [];
    const links: ChainLinkSpec[] = [];
    for (const e of entries) {
      const r = resolve(stage, model, e);
      links.push(linkOf(e.provider === 'deployment' ? { ...e, deployment: deploymentOf(e) } : e, model, r));
      if (typeof r !== 'string') targets.push(r);
      else if (!reasons.includes(r)) reasons.push(r);
    }
    if (described[stage as Stage].has(model)) chains[stage as Stage][model] = links;
    // Kept even when other entries were mounted: the 503 must also say that the fallback has no key.
    if (reasons.length) (unavailable[stage as Stage] as Record<string, string[]>)[model] = reasons;
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
  // Each app's own aliases (PUT /v1/apps/:app/routes), then MODEL_ROUTES on top (same model = replaced).
  for (const stage of ['chat', 'stt', 'tts'] as const) Object.assign(specs[stage], opts.appRoutes?.[stage] ?? {});
  for (const stage of ['chat', 'stt', 'tts'] as const) Object.assign(specs[stage], opts.modelRoutes?.[stage] ?? {});
  // Chains reported by /health: every app's aliases and whatever MODEL_ROUTES declares.
  const declaredModels = (stage: Stage) => [...Object.keys(opts.appRoutes?.[stage] ?? {}), ...Object.keys(opts.modelRoutes?.[stage] ?? {})];
  described = {
    chat: new Set(declaredModels('chat').filter(m => m !== '*')),
    stt: new Set(declaredModels('stt')),
    tts: new Set(declaredModels('tts')),
  };

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
  // Mounted even without a usable key: an `org/model` id is then a known-but-unavailable model (503 naming the key),
  // not an unknown one (404).
  const chatDynamicRoutes: ChatDynamicRoute[] = openrouterLLM ? [{
    providerId: 'openrouter',
    provider: openrouterLLM,
    acceptsModel: (model) => OPENROUTER_PASSTHROUGH.test(model),
    upstreamModel: (model) => (model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model),
    ...(openrouterUsable ? {} : { unavailableReason: reasonFor('openrouter') }),
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
      openrouterRouting: openrouterUsable ? 'dynamic-passthrough' : 'disabled',
      chatModels: Object.keys(chatRoutes),
      sttModels: Object.keys(stt),
      ttsModels: Object.keys(tts),
      chatFallback: chatFallbackChain.map(e => `${e.providerId}:${e.model}`),
      // Entries whose own deployment is not registered and that go to their `oneGpuDeployment` instead.
      ...(oneGpu.length ? { oneGpu } : {}),
      // Models with no provider at all (the rest of `unavailable` are chains that lost some entries).
      unavailable: {
        chat: Object.keys(unavailable.chat).filter(m => !chatRoutes[m]),
        stt: Object.keys(unavailable.stt).filter(m => !stt[m]),
        tts: Object.keys(unavailable.tts).filter(m => !tts[m]),
      },
    },
    chains,
  };
}

/** One link of a chain as `/health` reports it: mounted (maybe temporarily unusable) or not, and why. */
function linkOf(e: RouteEntrySpec, gatewayModel: string, r: RouteTarget<unknown> | string): ChainLinkSpec {
  const isDeployment = e.provider === 'deployment';
  const target = isDeployment ? `deployment:${e.deployment ?? ''}` : `${e.provider}:${e.model ?? gatewayModel}`;
  const base = { target, providerId: isDeployment ? target : e.provider, ...(isDeployment ? { deployment: e.deployment ?? '' } : {}) };
  if (typeof r === 'string') return { ...base, notMounted: r };
  return { ...base, ...(r.unavailableNow ? { unavailableNow: r.unavailableNow } : {}) };
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
  /** Effective chain per stage (`stage-chains.ts`). */
  chains?: () => { stages: unknown; warnings: string[] };
  /** Declared deployments' status (`deployments/declared.ts`). */
  declared?: () => unknown;
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
  const chains = deps.chains?.();
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
      ...(chains ? { stages: chains.stages, warnings: chains.warnings } : {}),
      ...(deps.declared ? { declared: deps.declared() } : {}),
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
