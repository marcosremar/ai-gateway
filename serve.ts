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
import { zaiLLM, ZAI_LLM_MODELS } from './src/gateway/providers/cloud/zai';
import { DeploymentLLMProvider, DeploymentSTTProvider, DeploymentTTSProvider } from './src/deployments/inference-providers';
import {
  buildServeProviders, checkOpenRouterKey, deepHealthReport, parseModelRoutes, providersOfKeys, replaceProviderMapping,
} from './src/config/serve-providers';
import { createFallbackWatch, stageChainsReport, type ChainLinkSpec } from './src/config/stage-chains';
import { accountPolicyGuards } from './src/gateway/proxy/account-policy-guard';
import { DeclaredDeploymentReconciler } from './src/deployments/declared';
import { createKeyAdminRoutes, KeyManager } from './src/config/key-manager';
import { createS2SRoute } from './src/s2s/route';
import { streamCuts } from './src/telemetry/stream-cuts';
import { createS2SAccess } from './src/s2s/access';
import { appStagesView, realtimeHealth } from './src/gateway/proxy/health-view';
import { loopbackStages } from './src/s2s/loopback-stages';
import { appForCall, appStageModels } from './src/s2s/app-stage-models';
import { proxyCircuitBreakers, resetProviderBreakers } from './src/gateway/proxy/provider-routing';
import { routingImage } from './src/providers/routing-image';
import { createLogger } from './src/logger';
import type { PrefixRoute } from './src/proxy/types';
import { adminListWarning, adminUsersFromEnv, deploymentsFromEnv, proxyIdleTimeoutMs, DEVICE_HEADER } from './src/deployments';
import { ApiKeyRegistry } from './src/gateway/proxy/middleware/api-keys';
import { AppLimits } from './src/gateway/proxy/app-limits';
import { createWebhookDelivery } from './src/webhooks';
import { gatewayClientKeys, loadSandboxEnv, principalSandboxToken, TOKEN_ALIASES } from './src/config/sandbox-env';
import {
  deploymentLogToTelemetry, emitGatewayEvent, latencyReport, realtimeSinkToTelemetry, sessionResolverFrom, setGatewayTelemetrySink, telemetryFromEnv,
  type LatencyReport,
} from './src/telemetry';
import { createRealtime } from './src/realtime';

const log = createLogger('serve');

// /v1/workloads (server/workload-handlers) is NOT mounted: it answered any app key with no admin check (API audit
// 2026-10-07). Its handlers (server/workload-handlers, server/http-utils) were removed with the rest of the legacy server/.

// SANDBOX_TOKEN is the only secret the gateway needs in its environment: the rest (SCW_SECRET_KEY, SCW_PROJECT_ID,
// OPENROUTER_API_KEY, … — whatever the palco catalog holds) comes from the dev API, whose values win over Railway
// variables (see sandbox-env.ts). It is NOT a client key nor an admin (`gatewayClientKeys`; transition flag
// ACCEPT_SANDBOX_TOKEN_AS_KEY=1 restores that).
const sandboxEnv = await loadSandboxEnv(process.env);
if (sandboxEnv.source) log.log({ source: sandboxEnv.source, applied: sandboxEnv.applied }, 'Loaded keys from the dev API');
else if (sandboxEnv.errors.length) log.warn({ errors: sandboxEnv.errors }, 'Dev API unreachable — using the environment only');
const SANDBOX_TOKEN = principalSandboxToken(process.env);

const PORT = parseInt(process.env.PORT || '4000');
const clientKeys = gatewayClientKeys(process.env);
for (const w of clientKeys.warnings) log.warn({}, `WARNING: ${w}`);
const API_KEYS = clientKeys.keys;
/** Admins on top of DEPLOYMENTS_ADMIN_USERS: none, or the `sandbox` user under ACCEPT_SANDBOX_TOKEN_AS_KEY=1. */
const EXTRA_ADMINS = clientKeys.sandboxAdmins;
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

// Deployments: Docker image → autoscaled replicas on Scaleway and/or Vast (enabled when SCW_SECRET_KEY or VAST_API_KEY is set).
const keyRegistry = new ApiKeyRegistry((API_KEYS ?? []).join(','));
// Declared deployments (src/deployments/declared/*.json): registered at boot and every 5 min, never woken here.
let declared: DeclaredDeploymentReconciler | null = null;
const deployments = deploymentsFromEnv(process.env, {
  alwaysAdmin: EXTRA_ADMINS,
  userOf: (req) => keyRegistry.resolve((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))?.userId ?? null,
  // Autoscale decisions and replica lifecycle also become gateway telemetry events (src/telemetry/gateway-events.ts).
  log: (msg, data) => { log.log(data ?? {}, msg); deploymentLogToTelemetry(msg, data); },
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
  log.log({}, 'Deployments disabled (no SCW_SECRET_KEY / VAST_API_KEY)');
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
    // Adaptive hedge (D4, live QA 2026-10-07): spill or wait for the replica instead of running each request twice.
    deploymentHedge: controller ? (name, baseMs, capMs) => controller.hedgeDelayMs(name, baseMs, capMs) : undefined,
  });
  const { providers: routed, summary } = built;
  log.log(summary, 'Providers configured');
  chains = built.chains;
  // Image routing: dit360 → local GPU 360°, fal-ai/* → fal.ai cloud
  return { ...routed, image: routingImage };
}
const providers = mountProviders();
remount = () => replaceProviderMapping(providers as Record<string, unknown>, mountProviders() as Record<string, unknown>);

const chainsNow = () => stageChainsReport(chains, {
  ...(controller ? {
    deploymentStatus: (name: string) => controller.get(name)?.status ?? null,
    stageOut: (name: string, stage: string) => {
      const ready = controller.get(name)?.replicas.filter(r => r.phase === 'ready') ?? [];
      return { ready: ready.length, out: ready.filter(r => r.stagesOut.includes(stage)).length };
    },
  } : {}),
  declaredPending: (name) => {
    const s = declared?.statusOf(name);
    return s && (s.state === 'pending' || s.state === 'error') ? s.reason : null;
  },
  breakers: proxyCircuitBreakers,
});
const fallbackWatch = createFallbackWatch((msg, data) => (msg.endsWith('on fallback') ? log.warn(data, msg) : log.log(data, msg)));
let latency: (() => LatencyReport) | null = null;
/**
 * Effective chain of every parle stage and the state of each link (shown by /health — nothing silent), whether any
 * chain is served by its fallback and since when, and the stage latencies of the last minutes.
 */
const chainHealth = () => {
  const report = chainsNow();
  return { ...report, fallback: fallbackWatch(report.stages), latency: latency?.() ?? null };
};
setInterval(() => fallbackWatch(chainsNow().stages), 15_000).unref();

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

// GET /health?deep=1 and /v1/admin/keys — same admins as deployments: DEPLOYMENTS_ADMIN_USERS only.
// An empty list grants nobody (fail closed; it used to make every key an admin).
const adminUsers = adminUsersFromEnv(process.env, EXTRA_ADMINS);
const adminWarning = adminListWarning(process.env, EXTRA_ADMINS);
if (adminWarning) log.warn({}, `WARNING: ${adminWarning}`);
const isAdminToken = (token: string) => {
  const userId = keyRegistry.resolve(token)?.userId;
  return Boolean(userId && adminUsers.has(userId));
};
// What a leaked non-admin app key can do (src/gateway/proxy/app-limits.ts): its app's own aliases only, max_tokens
// clamped (APP_MAX_TOKENS), daily budget (APP_DAILY_REQUESTS / APP_DAILY_TOKENS). Admin keys are never limited.
const appAliasesOf = (userId: string, stage: string): Set<string> | null => {
  const routes = deployments?.apps.get(userId)?.routes?.[stage as 'chat' | 'stt' | 'tts'];
  return routes ? new Set(Object.keys(routes)) : null;
};
const alertWebhook = process.env.ALERT_WEBHOOK_URL?.trim() ? createWebhookDelivery({ url: process.env.ALERT_WEBHOOK_URL.trim() }) : null;
const appLimits = API_KEYS.length ? new AppLimits({
  env: process.env,
  isAdmin: (userId) => adminUsers.has(userId),
  aliasesOf: appAliasesOf,
  limitsOf: (userId) => deployments?.apps.get(userId)?.limits,
  onBudgetEvent: ({ event, ...attrs }) => {
    log.warn(attrs, `app limits: daily budget ${event === 'app.budget_exhausted' ? 'exhausted' : 'at 80 %'}`);
    emitGatewayEvent(event, { level: event === 'app.budget_exhausted' ? 'error' : 'warn', attrs });
    void alertWebhook?.send({ event, data: attrs });
  },
}) : undefined;
// POST /v1/s2s: a non-admin key uses only its own app's deployments, under its app limits (src/s2s/access.ts).
const s2sAdmit = createS2SAccess({
  userOf: (req) => (API_KEYS.length ? keyRegistry.resolve(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))?.userId ?? '' : null),
  isAdmin: (userId) => adminUsers.has(userId),
  deploymentApp: (name) => { const d = controller?.get(name); return d ? d.app ?? null : undefined; },
  appRoutes: (app) => deployments?.apps.get(app)?.routes,
  ...(appLimits ? { limits: appLimits } : {}),
});

// Telemetry (docs/api/telemetry.md): POST /v1/telemetry/events from browsers (session token), edges (replica HMAC) and
// server apps (app key); admin queries under /v1/telemetry/*. The gateway's own events go to the same store.
// Telemetry auth resolves realtime session tokens through the realtime service, created further down (it needs the sink).
let realtimeSessionOf: ((token: string) => { sid: string; app: string; dep: string; rep: string } | null) | null = null;
const telemetry = telemetryFromEnv(process.env, {
  auth: {
    resolveSessionToken: (token) => realtimeSessionOf?.(token) ?? null,
    resolveAppKey: (token) => keyRegistry.resolve(token)?.userId ?? null,
    isMasterKey: (token) => TOKEN_ALIASES.some(k => process.env[k]?.trim() === token),
    deployment: (name) => {
      const replicaToken = controller?.tokenOf(name);
      const app = controller?.get(name)?.app;
      return replicaToken ? { replicaToken, ...(app ? { app } : {}) } : null;
    },
    replica: (id) => controller?.replicaAuth(id) ?? null,
  },
  isAdminToken,
  log: (msg, data) => log.log(data ?? {}, msg),
});
if (telemetry) {
  await telemetry.start();
  setGatewayTelemetrySink((event) => telemetry.ingest.ingestOwn(event));
  latency = () => latencyReport(telemetry.store.rows(), Date.now());
  log.log({ rows: telemetry.store.size }, 'Telemetry enabled');
}

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
// Stage models of the composed fallback: config.models, else S2S_<STAGE>_MODEL, else the calling app's own route aliases.
const s2sStageModels = (req: import('http').IncomingMessage, config: { deployment?: string; models?: { stt?: string; chat?: string; tts?: string } }) => {
  const deployment = config.deployment?.trim() || process.env.S2S_DEPLOYMENT?.trim() || undefined;
  const callerApp = keyRegistry.resolve(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))?.userId;
  const app = appForCall({ deploymentApp: deployment ? controller?.get(deployment)?.app : null, callerApp, callerIsAdmin: Boolean(callerApp && adminUsers.has(callerApp)) });
  const derived = appStageModels(app ? deployments?.apps.get(app)?.routes : undefined, deployment);
  return {
    stt: config.models?.stt || process.env.S2S_STT_MODEL?.trim() || derived.stt,
    chat: config.models?.chat || process.env.S2S_CHAT_MODEL?.trim() || derived.chat,
    tts: config.models?.tts || process.env.S2S_TTS_MODEL?.trim() || derived.tts,
  };
};
const s2sRoute = createS2SRoute({
  controller,
  deployment: process.env.S2S_DEPLOYMENT?.trim() || undefined,
  admit: s2sAdmit,
  hedgeMs: optionalMs(process.env.S2S_HEDGE_MS),
  budgetMs: optionalMs(process.env.S2S_BUDGET_MS),
  maxGapMs: optionalMs(process.env.S2S_MAX_GAP_MS),
  primarySpeaksJson: process.env.S2S_PRIMARY_SPEAK_FIELD === '1',
  stagesFor: (req, config) => loopbackStages({
    baseUrl: `http://127.0.0.1:${PORT}`,
    authorization: String(req.headers.authorization ?? ''),
    models: s2sStageModels(req, config),
  }),
  log: (msg, data) => log.log(data ?? {}, msg),
});

// Realtime voice (src/realtime, docs/realtime.md): POST /v1/realtime/sessions with the app key; the browser routes
// (signaling, WS relay) authenticate with the session token and are mounted in front of the proxy below.
const realtime = createRealtime({
  controller, defaultDeployment: process.env.S2S_DEPLOYMENT?.trim() || undefined,
  // Test/e2e knobs: a shorter media-path recheck (default 30 min) and a fake "firewall dropped our UDP probe" for
  // boxes where neither the security group nor iptables can be touched (REALTIME_PROBE_UDP=blocked).
  netRecheckMs: optionalMs(process.env.REALTIME_NET_RECHECK_MS),
  turnCheckMs: optionalMs(process.env.REALTIME_TURN_CHECK_MS),
  ...(process.env.REALTIME_PROBE_UDP === 'blocked'
    ? { probeUdpImpl: async () => ({ result: 'blocked' as const, rttMs: null, tries: 0 }) }
    : {}),
  // No keys configured: the proxy only lets localhost in, as `localhost` (dev), which may use any deployment.
  userOf: (req) => (API_KEYS.length ? keyRegistry.resolve(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))?.userId ?? null : 'localhost'),
  isAdmin: (userId) => adminUsers.has(userId) || (!API_KEYS.length && userId === 'localhost'),
  ...(appLimits ? { charge: (userId: string, n: number) => appLimits.chargeRequests(userId, n) } : {}),
  ...(deployments ? { devices: deployments.devices } : {}),
  ...(telemetry ? { telemetry: realtimeSinkToTelemetry(telemetry.ingest) } : {}),
  log: (msg, data) => log.log(data ?? {}, msg),
});
realtimeSessionOf = sessionResolverFrom(realtime.service);
if (deployments) deployments.devices.onBlock = (app, device) => { void realtime.service.endDeviceSessions(app, device); };
const deviceGate = deployments && ((userId: string, headers: import('http').IncomingHttpHeaders, kind: string) => {
  const named = typeof headers['x-app'] === 'string' ? headers['x-app'].trim() : null;
  return deployments.devices.admit(adminUsers.has(userId) ? named : userId, headers[DEVICE_HEADER], kind);
});

const server = await startProxy({
  port: PORT,
  hostname: '0.0.0.0',
  apiKeys: API_KEYS,
  providers,
  deepHealth,
  ...(appLimits ? { appLimits } : {}),
  ...(deviceGate ? { deviceGate } : {}),
  // GET /health?details=1: an admin sees every chain, an app key the chains of its own aliases (health-view.ts).
  healthDetails: (viewer) => (viewer.admin
    ? { ...chainHealth(), turn: realtime.service.turnHealth(), realtime: realtimeHealth(controller?.list() ?? []), streams: streamCuts(), appBudgets: appLimits?.budgets() ?? [] }
    : { ...appStagesView(chainsNow(), (stage) => appAliasesOf(viewer.userId, stage)), appBudgets: appLimits?.budgets(viewer.userId) ?? [] }),
  customRoutes: [
    ...createKeyAdminRoutes(keyManager, isAdminToken), { method: 'POST', path: '/v1/s2s', handler: s2sRoute }, realtime.route, realtime.updateRoute,
    ...(telemetry?.adminRoutes ?? []),
  ],
  ...(telemetry ? { publicRoutes: telemetry.publicRoutes } : {}),
  ...(prefixRoutes.length > 0 ? { prefixRoutes } : {}),
  ...(RATE_LIMIT_RPM > 0 ? { rateLimit: { rpm: RATE_LIMIT_RPM } } : {}),
});

realtime.mount(server);

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
    void deployments?.devices.flush().catch(() => {});
    realtime.stop();
    declared?.stop();
    keyManager.stop();
    telemetry?.stop();
    setGatewayTelemetrySink(null);
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
