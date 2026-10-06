/**
 * Lightweight production entry point — starts the AI Gateway proxy server.
 *
 * Wires providers directly to avoid the server/state.ts → Prisma dependency. Every provider is optional: only the
 * ones with a key are mounted (see src/config/serve-providers.ts); deployments (/v1/deployments) need SCW_SECRET_KEY.
 *
 * Usage:
 *   bun run serve.ts
 */

import { startProxy } from './src/proxy/server';
import { groqSTT, groqLLM, groqTTS } from './src/providers/groq';
import { openrouterLLM, openrouterSTT, openrouterTTS } from './src/gateway/providers/cloud/openrouter';
import { openaiSTT } from './src/gateway/providers/cloud/openai';
import { fireworksSTT } from './src/gateway/providers/cloud/fireworks';
import { deepgramSTT } from './src/gateway/providers/cloud/deepgram';
import { zaiLLM, ZAI_LLM_MODELS } from './src/modules/gateway/providers/cloud/zai';
import { DeploymentLLMProvider, DeploymentSTTProvider, DeploymentTTSProvider } from './src/deployments/inference-providers';
import {
  buildServeProviders, checkOpenRouterKey, deepHealthReport, parseModelRoutes, providersOfKeys, replaceProviderMapping,
} from './src/config/serve-providers';
import { stageChainsReport, type ChainLinkSpec } from './src/config/stage-chains';
import { accountPolicyGuards } from './src/gateway/proxy/account-policy-guard';
import { DeclaredDeploymentReconciler } from './src/deployments/declared';
import { createKeyAdminRoutes, KeyManager } from './src/config/key-manager';
import { createS2SRoute } from './src/s2s/route';
import { loopbackStages } from './src/s2s/loopback-stages';
import { proxyCircuitBreakers, resetProviderBreakers } from './src/gateway/proxy/provider-routing';
import { routingImage } from './src/providers/routing-image';
import { createLogger } from './src/logger';
import type { PrefixRoute } from './src/proxy/types';
import { deploymentsFromEnv, proxyIdleTimeoutMs } from './src/deployments';
import { ApiKeyRegistry } from './src/gateway/proxy/middleware/api-keys';
import { loadSandboxEnv, principalSandboxToken } from './src/config/sandbox-env';

const log = createLogger('serve');

// Workload handlers live in server/ which is NOT included in the Fly.io
// Docker image (only src/ + serve.ts are copied). Dynamic import with
// fallback so the proxy starts regardless.
let routeWorkloadRequest: ((req: any, res: any, path: string, method: string) => boolean) | null = null;
try {
  const wh = require('./server/workload-handlers');
  routeWorkloadRequest = wh.routeWorkloadRequest;
  const { workloadRegistry, GpuWorkloadDriver } = require('./src/workloads');
  workloadRegistry.registerDriver(new GpuWorkloadDriver());
  log.log({}, 'Workload registry initialized (gpu driver)');
} catch {
  log.log({}, 'Workload handlers not available (server/ not bundled) — skipping');
}

// SANDBOX_TOKEN is the only secret the gateway needs in its environment: the rest (SCW_SECRET_KEY, SCW_PROJECT_ID,
// OPENROUTER_API_KEY, … — whatever the palco catalog holds) comes from the dev API, whose values win over Railway
// variables (see sandbox-env.ts). The same token is accepted as an admin Bearer.
const sandboxEnv = await loadSandboxEnv(process.env);
if (sandboxEnv.source) log.log({ source: sandboxEnv.source, applied: sandboxEnv.applied }, 'Loaded keys from the dev API');
else if (sandboxEnv.errors.length) log.warn({ errors: sandboxEnv.errors }, 'Dev API unreachable — using the environment only');
const SANDBOX_TOKEN = principalSandboxToken(process.env);
const SANDBOX_USER = 'sandbox';

const PORT = parseInt(process.env.PORT || '4000');
const configuredKeys = process.env.GATEWAY_API_KEYS
  ? process.env.GATEWAY_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : [];
if (SANDBOX_TOKEN && /[,:]/.test(SANDBOX_TOKEN)) log.warn({}, 'SANDBOX_TOKEN contains , or : — not accepted as an API key');
const API_KEYS = [
  ...configuredKeys,
  ...(SANDBOX_TOKEN && !/[,:]/.test(SANDBOX_TOKEN) ? [`${SANDBOX_TOKEN}:${SANDBOX_USER}`] : []),
];
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '0');

async function listOpenRouterModels(): Promise<string[]> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`OpenRouter models failed: ${response.status}`);
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  return (payload.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

log.log({ port: PORT, apiKeys: API_KEYS ? API_KEYS.length : 0, rateLimit: RATE_LIMIT_RPM || 'disabled' }, 'Starting AI Gateway');

const prefixRoutes: PrefixRoute[] = [];
if (routeWorkloadRequest) {
  prefixRoutes.push({ prefix: '/v1/workloads', handler: routeWorkloadRequest });
}

// Deployments: Docker image → autoscaled replicas on Scaleway (enabled when SCW_SECRET_KEY is set).
const keyRegistry = new ApiKeyRegistry((API_KEYS ?? []).join(','));
// Declared deployments (src/deployments/declared/*.json): registered at boot and every 5 min, never woken here.
let declared: DeclaredDeploymentReconciler | null = null;
const deployments = deploymentsFromEnv(process.env, {
  alwaysAdmin: [SANDBOX_USER],
  userOf: (req) => keyRegistry.resolve((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))?.userId ?? null,
  log: (msg, data) => log.log(data ?? {}, msg),
  declaredStatus: () => declared?.status() ?? [],
  // An app sent new routes (PUT /v1/apps/:app/routes): mount them now, like a key change does.
  onRoutesChange: () => remount?.(),
});
if (deployments) {
  await deployments.controller.init();
  await deployments.apps.init();
  deployments.controller.start();
  prefixRoutes.push({ prefix: '/v1/deployments', handler: deployments.handler });
  prefixRoutes.push({ prefix: '/v1/profiles', handler: deployments.handler });
  prefixRoutes.push({ prefix: '/v1/apps', handler: deployments.handler });
  // Read by createProxyServer: a cold-start wait must outlive the default 60 s idle cut.
  process.env.PROXY_TOTAL_TIMEOUT_MS = proxyIdleTimeoutMs(process.env, true)!;
  log.log({ namespace: deployments.controller.namespace, proxyIdleMs: process.env.PROXY_TOTAL_TIMEOUT_MS }, 'Deployments enabled (scaleway)');
} else {
  log.log({}, 'Deployments disabled (no SCW_SECRET_KEY)');
}

// Providers: only the configured ones are mounted. Each app sends its own aliases (PUT /v1/apps/:app/routes: a
// self-hosted deployment first, OpenRouter as the fallback); MODEL_ROUTES on top. See src/config/serve-providers.ts.
const modelRoutes = parseModelRoutes(process.env.MODEL_ROUTES);
if (modelRoutes.errors.length) log.warn({ errors: modelRoutes.errors }, 'MODEL_ROUTES has invalid parts — skipped');
const controller = deployments?.controller ?? null;
let openrouterKey = await checkOpenRouterKey(process.env);
let chains: Record<string, Record<string, ChainLinkSpec[]>> = {};
// Assigned below; the reconciler's onChange (periodic runs) remounts the routes once they exist.
let remount: (() => void) | null = null;
declared = process.env.DECLARED_DEPLOYMENTS === '0' ? null : new DeclaredDeploymentReconciler({
  target: controller,
  env: process.env,
  log: (msg, data) => log.log(data ?? {}, msg),
  onChange: () => remount?.(),
});
if (declared) {
  const status = await declared.reconcile();
  log.log({ declared: status.map(s => ({ name: s.name, state: s.state, reason: s.reason })) }, 'Declared deployments');
  declared.start();
}

function mountProviders() {
  const built = buildServeProviders({
    instances: {
      chat: { groq: groqLLM, openrouter: openrouterLLM, zai: zaiLLM },
      stt: { groq: groqSTT, openrouter: openrouterSTT, openai: openaiSTT, fireworks: fireworksSTT, deepgram: deepgramSTT },
      tts: { groq: groqTTS, openrouter: openrouterTTS },
    },
    env: process.env,
    openrouter: openrouterKey,
    modelRoutes: modelRoutes.routes,
    appRoutes: deployments?.apps.allRoutes() ?? {},
    zaiModels: ZAI_LLM_MODELS.map(m => m.id),
    listOpenRouterModels,
    // One-GPU mode: an entry whose own deployment is not registered goes to its `oneGpuDeployment` when that one is.
    deploymentExists: (name) => Boolean(controller?.get(name)),
    deploymentProvider: controller ? (stage, name) => (
      stage === 'chat' ? new DeploymentLLMProvider(controller, name)
        : stage === 'stt' ? new DeploymentSTTProvider(controller, name)
          : new DeploymentTTSProvider(controller, name)
    ) : undefined,
  });
  const { providers: routed, summary } = built;
  log.log(summary, 'Providers configured');
  chains = built.chains;
  // Image routing: dit360 → local GPU 360°, fal-ai/* → fal.ai cloud
  return { ...routed, image: routingImage };
}
const providers = mountProviders();
remount = () => replaceProviderMapping(providers as Record<string, unknown>, mountProviders() as Record<string, unknown>);

/** Effective chain of every parle stage and the state of each link (shown by /health — nothing silent). */
const chainHealth = () => stageChainsReport(chains, {
  ...(controller ? { deploymentStatus: (name: string) => controller.get(name)?.status ?? null } : {}),
  declaredPending: (name) => {
    const s = declared?.statusOf(name);
    return s && (s.state === 'pending' || s.state === 'error') ? s.reason : null;
  },
  breakers: proxyCircuitBreakers,
});

// Keys change at runtime: re-read from the palco every 5 min and on POST /v1/admin/keys/reload; PUT /v1/admin/keys
// writes them to the palco. A key that appears or disappears re-mounts the providers in place.
const keyManager = new KeyManager(process.env, {
  log: (msg, data) => log.log(data ?? {}, msg),
  onChange: async (names) => {
    if (names.includes('OPENROUTER_API_KEY')) openrouterKey = await checkOpenRouterKey(process.env);
    for (const id of providersOfKeys(names)) {
      resetProviderBreakers(id);
      accountPolicyGuards.resetProvider(id);
    }
    // A credential or image that appeared (GHCR_READ_TOKEN, SPEECH_IMAGE) registers the declared deployment now.
    await declared?.reconcile();
    remount?.();
  },
});
keyManager.adopt(sandboxEnv.received);
if (SANDBOX_TOKEN) keyManager.start();

// GET /health?deep=1 — same admins as deployments (SANDBOX_TOKEN user + DEPLOYMENTS_ADMIN_USERS; with no admin
// list, any gateway API key).
const adminUsers = (process.env.DEPLOYMENTS_ADMIN_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const isAdminToken = (token: string) => {
  const userId = keyRegistry.resolve(token)?.userId;
  if (!userId) return false;
  return adminUsers.length === 0 || [...adminUsers, SANDBOX_USER].includes(userId);
};
const deepHealth = {
  authorize: isAdminToken,
  report: () => deepHealthReport({
    env: process.env, breakers: proxyCircuitBreakers, providers, deployments: controller, chains: chainHealth,
    ...(declared ? { declared: () => declared!.status() } : {}),
  }),
};

// POST /v1/s2s — speech-to-speech in one streamed request: the speech-stack deployment first, the composed pipeline
// over the stage chains (loopback into this gateway, with the caller's own key) as fallback. See src/s2s/route.ts.
const optionalMs = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
const s2sRoute = createS2SRoute({
  controller,
  deployment: process.env.S2S_DEPLOYMENT?.trim() || undefined,
  hedgeMs: optionalMs(process.env.S2S_HEDGE_MS),
  budgetMs: optionalMs(process.env.S2S_BUDGET_MS),
  primarySpeaksJson: process.env.S2S_PRIMARY_SPEAK_FIELD === '1',
  stagesFor: (req, config) => loopbackStages({
    baseUrl: `http://127.0.0.1:${PORT}`,
    authorization: String(req.headers.authorization ?? ''),
    models: {
      stt: config.models?.stt || process.env.S2S_STT_MODEL?.trim() || undefined,
      chat: config.models?.chat || process.env.S2S_CHAT_MODEL?.trim() || undefined,
      tts: config.models?.tts || process.env.S2S_TTS_MODEL?.trim() || undefined,
    },
  }),
  log: (msg, data) => log.log(data ?? {}, msg),
});

const server = await startProxy({
  port: PORT,
  hostname: '0.0.0.0',
  apiKeys: API_KEYS,
  providers,
  deepHealth,
  healthDetails: () => chainHealth(),
  customRoutes: [...createKeyAdminRoutes(keyManager, isAdminToken), { method: 'POST', path: '/v1/s2s', handler: s2sRoute }],
  ...(prefixRoutes.length > 0 ? { prefixRoutes } : {}),
  ...(RATE_LIMIT_RPM > 0 ? { rateLimit: { rpm: RATE_LIMIT_RPM } } : {}),
});

// ── Process-level error handlers ─────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[serve] Uncaught exception — exiting:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[serve] Unhandled rejection:', reason);
});

// ── Graceful shutdown with request draining ──────────────────────────────────

let shuttingDown = false;
let activeRequests = 0;

// Track in-flight requests for graceful drain
server.on('request', (_req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
  activeRequests++;
  res.on('finish', () => { activeRequests--; });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    deployments?.controller.stop();
    declared?.stop();
    keyManager.stop();
    console.log(`[serve] Received ${signal}, draining ${activeRequests} active request(s)...`);

    // Stop accepting new connections
    server.close(() => {
      console.log('[serve] All connections drained. Exiting.');
      process.exit(0);
    });

    // Poll active requests — exit early if all drained
    const drainCheck = setInterval(() => {
      if (activeRequests <= 0) {
        clearInterval(drainCheck);
        console.log('[serve] All requests completed. Exiting.');
        process.exit(0);
      }
      console.log(`[serve] Waiting for ${activeRequests} request(s) to complete...`);
    }, 1000);

    // Force exit after 25s (before Fly's 30s kill_timeout)
    setTimeout(() => {
      clearInterval(drainCheck);
      console.error(`[serve] Drain timeout — forcing exit (${activeRequests} requests abandoned)`);
      process.exit(1);
    }, 25_000).unref();
  });
}
