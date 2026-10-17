/**
 * Lightweight production entry point — starts the AI Gateway proxy server.
 *
 * Wires providers directly to avoid the server/state.ts → Prisma dependency. Every provider is optional: only the
 * ones with a key are mounted (see src/config/serve-providers.ts); deployments (/v1/deployments) need SCW_SECRET_KEY.
 *
 * Usage:
 *   bun run serve.ts
 */

import { homedir } from 'os';
import { join } from 'path';
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
import { AccessKeys, autoWakesNow } from './src/config/access-keys';
import { classWindowOpen } from './src/deployments/autoscale';
import { AdminGate } from './src/config/admin-gate';
import { createAccessRoutes } from './src/config/access-routes';
import { KeyAudit } from './src/config/key-audit';
import { createS2SRoute } from './src/s2s/route';
import { streamCuts } from './src/telemetry/stream-cuts';
import { createS2SAccess } from './src/s2s/access';
import { appStagesView, minimalHealth, realtimeHealth } from './src/gateway/proxy/health-view';
import { NO_APP, SpendLedger } from './src/deployments/spend-ledger';
import { llmTokensOf } from './src/accounts/usage';
import { loopbackStages } from './src/s2s/loopback-stages';
import { appForCall, appStageModels } from './src/s2s/app-stage-models';
import { proxyCircuitBreakers, resetProviderBreakers } from './src/gateway/proxy/provider-routing';
import { reorderSnapshot } from './src/gateway/proxy/link-reorder';
import { ttsCacheFromEnv } from './src/gateway/proxy/tts-cache';
import { routingImage } from './src/providers/routing-image';
import { createLogger } from './src/logger';
import type { PrefixRoute, UpgradeRoute } from './src/proxy/types';
import {
  adminListWarning, adminUsersFromEnv, bootEventsRoute, bootFilesRoute, deploymentsFromEnv, proxyIdleTimeoutMs, DEPLOYMENT_CREDENTIAL_KEYS, DEVICE_HEADER,
} from './src/deployments';
import { buildImages } from './src/deployments/build-images';
import { bootHistoryFile } from './src/deployments/boot-track';
import { AppLimits } from './src/gateway/proxy/app-limits';
import { createWebhookDelivery } from './src/webhooks';
import { createOpsAlerts, OPS_ALERT_BOOT_QUIET_MS, OPS_ALERT_DEDUP_MS } from './src/telemetry/ops-alerts';
import { alertEmailFromEnv, createAlertMailer, incidentResolvedMail, opsIncidentMail, secretValues } from './src/telemetry/alert-email';
import { createIncidents, incidentQuietMs } from './src/telemetry/incidents';
import { createBalanceWatch } from './src/telemetry/balance-watch';
import { createOverspendWatch, overspendLimitsFromEnv } from './src/telemetry/overspend';
import { createFallbackProbe, fallbackLinks } from './src/telemetry/fallback-probe';
import { applySandboxCache, gatewayClientKeys, principalSandboxToken, SANDBOX_USER, saveSandboxCache } from './src/config/sandbox-env';
import {
  deploymentLogToTelemetry, emitGatewayEvent, latencyReport, realtimeSinkToTelemetry, sessionResolverFrom, setGatewayTelemetrySink, telemetryFromEnv,
  type LatencyReport,
} from './src/telemetry';
import { createRealtime } from './src/realtime';
import { createRooms, kokoroSynthesize, maiSynthesize, openRouterTranslate, synthesizeWithFallback } from './src/rooms';
import { appTelemetryFromEnv } from './src/app-telemetry';
import { machinesFromEnv } from './src/machines';
import { createAccounts } from './src/accounts';
import { ModelBenchmarkStore } from './src/model-benchmarks/store';
import { createModelBenchmarkRoutes } from './src/model-benchmarks/routes';
import { adminTraffic, createAdminPage, createAlertLog, createModelPrices, createSuggestionDigest, recommendations, usageCost, type AdminSnapshot } from './src/admin-page';

const log = createLogger('serve');

// /v1/workloads (server/workload-handlers) is NOT mounted: it answered any app key with no admin check (API audit
// 2026-10-07). Its handlers (server/workload-handlers, server/http-utils) were removed with the rest of the legacy server/.

// SANDBOX_TOKEN is the only secret the gateway needs in its environment: the rest (SCW_SECRET_KEY, SCW_PROJECT_ID,
// OPENROUTER_API_KEY, … — whatever the palco catalog holds) comes from the dev API, whose values win over Railway
// variables (see sandbox-env.ts). It is NOT a client key nor an admin (`gatewayClientKeys`; transition flag
// ACCEPT_SANDBOX_TOKEN_AS_KEY=1 restores that).
// Client/admin keys, the admin list and the SANDBOX_TOKEN also change at runtime (src/config/access-keys.ts): issued,
// revoked and rotated through /v1/admin/access/*, persisted in the state dir, every change in key-audit.jsonl.
const stateDir = process.env.DEPLOYMENTS_STATE_DIR || join(homedir(), '.ai-gateway');
const keyAudit = new KeyAudit({ path: join(stateDir, 'key-audit.jsonl'), log: (msg, data) => log.log(data ?? {}, msg) });
const access = new AccessKeys(process.env, { path: join(stateDir, 'access.json'), log: (msg, data) => log.warn(data ?? {}, msg) });
await keyAudit.init();
await access.load().then(() => access.migratePolicies()).catch((err: unknown) => log.error({ error: err instanceof Error ? err.message : String(err) },
  'ACCESS STATE UNREADABLE: issued keys, revocations and the admin list from the API are not applied — restore access.json'));
const sandboxEnv = await access.bootSandboxEnv();
const sandboxCachePath = join(stateDir, 'sandbox-env.json');
if (sandboxEnv.source) {
  log.log({ source: sandboxEnv.source, applied: sandboxEnv.applied }, 'Loaded keys from the dev API');
  await saveSandboxCache(sandboxCachePath, process.env, sandboxEnv.received)
    .catch((err: unknown) => log.warn({ error: err instanceof Error ? err.message : String(err) }, 'Saving the key cache failed'));
} else {
  const cached = await applySandboxCache(sandboxCachePath, process.env);
  sandboxEnv.received.push(...cached);
  if (sandboxEnv.errors.length) log.warn({ errors: sandboxEnv.errors, cached }, 'Dev API unreachable — using the environment and the last keys it gave');
}
const SANDBOX_TOKEN = principalSandboxToken(process.env);

const PORT = parseInt(process.env.PORT || '4000');
const clientKeys = gatewayClientKeys(process.env);
for (const w of clientKeys.warnings) log.warn({}, `WARNING: ${w}`);
const API_KEYS = clientKeys.keys;
access.setBaseAdmins(adminUsersFromEnv(process.env));
access.start();
const adminUsers = access.admins;

// ucast.me accounts (src/accounts, docs/accounts.md): sign-up on ucast.me, per-user activation keys for the desktop
// app. An activation key resolves as the accounts app (ACCOUNTS_APP, default `babelcast`) — that app's routes and
// limits, never admin — and is metered per user/key with the user's quota. A state file that cannot be read disables
// the accounts (nothing would be overwritten); the rest of the gateway keeps running.
const configuredAccounts = createAccounts({
  isAdmin: (userId) => adminUsers.has(userId),
  log: (msg, data) => log.log(data ?? {}, msg),
  // Read at request time, once `realtime` (below) exists.
  sessionRequests: () => realtime.service.sessionRequests,
});
const accounts = await configuredAccounts.init().then(() => configuredAccounts, (err: unknown) => {
  log.error({ error: err instanceof Error ? err.message : String(err) },
    'ACCOUNTS DISABLED: accounts.json / account-usage.json cannot be read — restore them from the volume backup and restart');
  return null;
});
if (accounts) {
  log.log({ app: accounts.config.app, siteHosts: accounts.config.siteHosts, users: accounts.service.userCount, email: accounts.emailConfigured ? 'resend' : 'none' }, 'Accounts enabled');
  if (adminUsers.has(accounts.config.app)) log.error({ app: accounts.config.app }, 'ACCOUNTS: the accounts app is an ADMIN user — activation keys are refused until it is removed from the admin list');
}
/** Every gateway key: the access keys (env, issued, sandbox) and the accounts' activation keys. */
const keyRegistry = {
  get size(): number { return access.size + (accounts?.activeKeyCount ?? 0); },
  resolve: (token: string): { key: string; userId: string } | null => access.resolve(token) ?? accounts?.resolveAppKey(token) ?? null,
};
const keysConfigured = () => keyRegistry.size > 0;
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

log.log({ port: PORT, apiKeys: access.size, rateLimit: RATE_LIMIT_RPM || 'disabled' }, 'Starting AI Gateway');

const prefixRoutes: PrefixRoute[] = [];
const upgradeRoutes: UpgradeRoute[] = [];

// Deployments: Docker image → autoscaled replicas on Scaleway and/or Vast (enabled when SCW_SECRET_KEY or VAST_API_KEY is set).
const alertWebhook = process.env.ALERT_WEBHOOK_URL?.trim() ? createWebhookDelivery({ url: process.env.ALERT_WEBHOOK_URL.trim() }) : null;
const alertEmail = alertEmailFromEnv(process.env);
const alertMailer = alertEmail && createAlertMailer({ ...alertEmail, secrets: () => secretValues(process.env), log: (msg, data) => log.warn(data ?? {}, msg) });
const alertLog = createAlertLog();
const incidents = createIncidents({
  path: join(stateDir, 'incidents.json'),
  quietMs: incidentQuietMs(process.env),
  onResolve: (i) => {
    log.log({ incident: i.id, resolution: i.resolution, alerts: i.alertCount }, 'incident resolved');
    if (i.mailed) void alertMailer?.deliver(incidentResolvedMail(i, incidents.quietMinutes));
  },
  log: (msg, data) => log.warn(data ?? {}, msg),
});
await incidents.load().catch((err: unknown) => log.error({ error: err instanceof Error ? err.message : String(err) }, 'INCIDENTS STATE UNREADABLE: starts empty'));
const opsAlerts = createOpsAlerts((alert) => {
  log.warn(alert.data, `ALERT ${alert.event}`);
  alertLog.record(alert.event, alert.data);
  const incident = incidents.openOf(alert.event, alert.key ?? '');
  const out = opsIncidentMail(alert, incident);
  if (out) void alertMailer?.send(out.mail).then((id) => { if (id && out.opens && incident) incidents.markMailed(incident.id); });
  return alertWebhook?.send(alert);
}, Date.now, OPS_ALERT_DEDUP_MS, OPS_ALERT_BOOT_QUIET_MS, incidents);
// Declared deployments (src/deployments/declared/*.json): registered at boot and every 5 min, never woken here.
let declared: DeclaredDeploymentReconciler | null = null;
const configuredDeployments = deploymentsFromEnv(process.env, {
  admins: adminUsers,
  userOf: (req) => keyRegistry.resolve((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))?.userId ?? null,
  keyOf: (req) => {
    const found = access.resolve((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!found) return null;
    const app = found.userId === SANDBOX_USER ? process.env.SANDBOX_TOKEN_APP?.trim() || SANDBOX_USER : found.userId;
    return { keyId: found.keyId, user: found.userId, app, policy: access.policyOf(found.keyId) };
  },
  // Autoscale decisions and replica lifecycle also become gateway telemetry events (src/telemetry/gateway-events.ts).
  log: (msg, data) => { log.log(data ?? {}, msg); deploymentLogToTelemetry(msg, data); opsAlerts.fromDeploymentLog(msg, data); incidents.fromDeploymentLog(msg, data); },
  declaredStatus: () => declared?.status() ?? [],
  // An app sent new routes (PUT /v1/apps/:app/routes): mount them now, like a key change does.
  onRoutesChange: () => remount?.(),
  // App GPU status (app-gpu-health.ts): the cloud links' last probe says whether the reserve still answers.
  gpuHealth: {
    cloudLinks: () => fallbackProbe.snapshot().links.filter(l => !l.providerId.startsWith('local:')),
    onDegraded: (event) => emitGatewayEvent('app.degraded', { level: 'warn', attrs: { ...event } }),
  },
  audit: (entry) => keyAudit.record(entry),
});
const deployments = configuredDeployments && await configuredDeployments.controller.init()
  .then(() => configuredDeployments.apps.init())
  .then(() => configuredDeployments.apps.ensureCloudFallback())
  .then((added) => { if (added.length) log.warn({ added }, 'apps: cloud fallback appended to stored chains that had none (owner decision 2026-10-12)'); })
  .then(() => configuredDeployments.clientGpu.load())
  .then(() => configuredDeployments, (err: unknown) => {
    configuredDeployments.stopJanitor?.();
    log.error({ error: err instanceof Error ? err.message : String(err) },
      'DEPLOYMENTS DISABLED: the state file cannot be read — cloud routes stay up; fix or restore the file and restart');
    return null;
  });
const bootHistory = deployments && bootHistoryFile(join(stateDir, 'boot-history.json'), deployments.controller, (msg, data) => log.warn(data ?? {}, msg));
await bootHistory?.load().catch((err: unknown) => log.error({ error: err instanceof Error ? err.message : String(err) }, 'BOOT HISTORY UNREADABLE: past boots start empty'));
await deployments?.gpuValidation.load().catch((err: unknown) => log.error({ error: err instanceof Error ? err.message : String(err) }, 'GPU VALIDATIONS UNREADABLE: only the seeded ones count'));
if (deployments) {
  deployments.controller.start();
  bootHistory?.start();
  deployments.clientGpu.run();
  deployments.gpuHealth.probe.start();
  deployments.gpuValidation.start();
  prefixRoutes.push({ prefix: '/v1/deployments', handler: deployments.handler });
  prefixRoutes.push({ prefix: '/v1/profiles', handler: deployments.handler });
  prefixRoutes.push({ prefix: '/v1/apps', handler: deployments.handler });
  prefixRoutes.push({ prefix: '/v1/images', handler: deployments.handler });
  // WS upgrades under /v1/deployments/:name/invoke are relayed to the replica (CDP and other raw websockets).
  upgradeRoutes.push({ prefix: '/v1/deployments', handler: deployments.upgrade });
  // Read by createProxyServer: a cold-start wait must outlive the default 60 s idle cut.
  process.env.PROXY_TOTAL_TIMEOUT_MS = proxyIdleTimeoutMs(process.env, true)!;
  log.log({ namespace: deployments.controller.namespace, proxyIdleMs: process.env.PROXY_TOTAL_TIMEOUT_MS }, 'Deployments enabled (scaleway)');
} else {
  log.log({}, 'Deployments disabled (no SCW_SECRET_KEY / VAST_API_KEY, or off Railway without AIGW_REAL_MACHINES=1)');
}

const machineUserOf = (req: import('http').IncomingMessage) => keyRegistry.resolve((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))?.userId ?? null;
const configuredMachines = machinesFromEnv(process.env, {
  userOf: machineUserOf,
  isAdmin: (req) => adminUsers.has(machineUserOf(req) ?? ''),
  log: (msg, data) => log.log(data ?? {}, msg),
  onRailway: Boolean(process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID),
});
const machines = configuredMachines && await configuredMachines.controller.init().then(() => configuredMachines, (err: unknown) => {
  log.error({ error: err instanceof Error ? err.message : String(err) }, 'MACHINES DISABLED: machines.json cannot be read — fix or restore it and restart');
  return null;
});
if (machines) {
  machines.controller.start();
  prefixRoutes.push({ prefix: '/v1/machines', handler: machines.handler });
  prefixRoutes.push({ prefix: '/v1/jobs', handler: machines.handler });
  log.log({ namespace: machines.controller.namespace, providers: machines.controller.providers }, 'Machines enabled');
}

// Providers: only the configured ones are mounted. Each app sends its own aliases (PUT /v1/apps/:app/routes: a
// self-hosted deployment first, OpenRouter as the fallback); MODEL_ROUTES on top. See src/config/serve-providers.ts.
const modelRoutes = parseModelRoutes(process.env.MODEL_ROUTES);
if (modelRoutes.errors.length) log.warn({ errors: modelRoutes.errors }, 'MODEL_ROUTES has invalid parts — skipped');
const controller = deployments?.controller ?? null;
const ownerOfDeployment = (d: { name: string; app: string | null }) =>
  d.app ?? deployments?.apps.list().find(({ id }) => deployments.apps.get(id)?.profile?.gpuDeployments.includes(d.name))?.id ?? null;
const panelBaseUrl = (process.env.AIGW_PUBLIC_URL?.trim() || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/, '');
const spendLedger = new SpendLedger({
  path: join(stateDir, 'spend-ledger.json'),
  deployments: () => controller?.list() ?? [],
  ownerOf: ownerOfDeployment,
  log: (msg, data) => log.warn(data ?? {}, msg),
});
await spendLedger.load().catch((err: unknown) => log.error({ error: err instanceof Error ? err.message : String(err) }, 'SPEND LEDGER UNREADABLE: daily spend starts empty'));
spendLedger.start();
const balanceWatch = createBalanceWatch({
  env: process.env,
  spend: () => controller?.spendSummary() ?? null,
  onAlert: (mail, reading) => {
    log.warn({ kind: mail.kind, level: mail.level }, `ALERT ${mail.subject}`);
    alertLog.record(`balance.${mail.level}`, { subject: mail.subject });
    void alertMailer?.deliver(mail);
    return reading ? alertWebhook?.send({ event: `balance.${mail.level}`, data: { ...reading } }) : undefined;
  },
  log: (msg, data) => log.warn(data ?? {}, msg),
});
if (process.env.BALANCE_CHECK_MINUTES?.trim() !== '0') balanceWatch.start();
let openrouterKey = await checkOpenRouterKey(process.env);
let chains: Record<string, Record<string, ChainLinkSpec[]>> = {};
// Assigned below; the reconciler's onChange (periodic runs) remounts the routes once they exist.
let remount: (() => void) | null = null;
const benchmarkStore = new ModelBenchmarkStore(process.env.MODEL_BENCHMARKS_PATH?.trim() || join(stateDir, 'model-benchmarks.json'));
const benchmarks = await benchmarkStore.load().then(() => benchmarkStore, (err: unknown) => {
  log.error({ error: err instanceof Error ? err.message : String(err) }, 'MODEL BENCHMARKS DISABLED: model-benchmarks.json cannot be read — restore it and restart');
  return null;
});
if (benchmarks?.recovered) log.warn({ problem: benchmarks.recovered }, 'model-benchmarks.json was unreadable — recovered from the last good backup');
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
const bootRegistryWarning = deployments?.registryWarning() ?? null;
if (bootRegistryWarning) log.error({}, `ERROR: ${bootRegistryWarning}`);

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
    deploymentProvider: controller ? (stage, name, wait) => (
      stage === 'chat' ? new DeploymentLLMProvider(controller, name, wait)
        : stage === 'stt' ? new DeploymentSTTProvider(controller, name, wait)
          : new DeploymentTTSProvider(controller, name, wait)
    ) : undefined,
    // Adaptive hedge (D4, live QA 2026-10-07): spill or wait for the replica instead of running each request twice.
    deploymentHedge: controller ? (name, baseMs, capMs) => controller.hedgeDelayMs(name, baseMs, capMs) : undefined,
    ...(benchmarks ? { benchmarkRank: (stage: 'chat' | 'stt' | 'tts', dataset: string) => benchmarks.rankOrder(stage === 'chat' ? 'llm' : stage, dataset) } : {}),
    reorderFor: (stage, alias) => {
      const owner = deployments?.apps.list().find(({ id }) => Object.keys(deployments.apps.get(id)?.routes?.[stage] ?? {}).includes(alias));
      return owner ? deployments!.apps.get(owner.id)?.profile?.reorderCloudLinks !== false : true;
    },
  });
  const { providers: routed, summary } = built;
  log.log(summary, 'Providers configured');
  chains = built.chains;
  // Image routing: dit360 → local GPU 360°, fal-ai/* → fal.ai cloud
  return { ...routed, image: routingImage };
}
const providers = mountProviders();
remount = () => replaceProviderMapping(providers as Record<string, unknown>, mountProviders() as Record<string, unknown>);

// Every cloud link of the alias chains gets a minimal real request at boot and every 15 min (never a deployment).
const fallbackProbe = createFallbackProbe({
  env: process.env,
  links: () => fallbackLinks(chains, providers),
  onResults: (results) => opsAlerts.fromFallbackProbes(results),
  log: (msg, data) => log.warn(data ?? {}, msg),
});
fallbackProbe.start();

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
  const registryWarning = deployments?.registryWarning() ?? null;
  return {
    ...report, warnings: [...(report.warnings ?? []), ...(registryWarning ? [registryWarning] : [])],
    fallback: fallbackWatch(report.stages), latency: latency?.() ?? null,
  };
};
setInterval(() => {
  const { stages } = chainsNow();
  fallbackWatch(stages);
  opsAlerts.fromChains(stages);
  for (const name of opsAlerts.fromDeployments(deployments?.controller.list() ?? [])) {
    void deployments?.controller.park(name).then(
      () => {
        incidents.action('park', name, 'gateway: 60 min fora da janela de aula');
        log.warn({ deployment: name }, 'deployments: parked — up 60 min outside its class window, no class open');
        deploymentLogToTelemetry('deployments: parked outside the class window', { deployment: name });
      },
      (err: unknown) => log.error({ deployment: name, error: err instanceof Error ? err.message : String(err) }, 'deployments: park outside the class window failed'),
    );
  }
  opsAlerts.fromLatency(latency?.() ?? null);
  incidents.tick(reorderSnapshot());
}, 15_000).unref();

// Keys change at runtime: re-read from the palco every 5 min and on POST /v1/admin/keys/reload; PUT /v1/admin/keys
// writes them to the palco. A key that appears or disappears re-mounts the providers in place.
// A machine credential that changed is validated before its backend uses it; a refused one is put back in the
// environment (the backend keeps the previous one, nothing in flight is touched) and retried on the next reload.
async function rotateDeploymentCredentials(names: string[]) {
  const changed = names.filter(n => (DEPLOYMENT_CREDENTIAL_KEYS as readonly string[]).includes(n));
  if (!changed.length || !deployments) return;
  const r = await deployments.rotateCredentials(process.env);
  for (const { provider, error } of r.rejected) log.error({ provider, error }, 'New machine credentials refused — keeping the previous ones');
  if (r.needsRestart.length) log.warn({ providers: r.needsRestart }, 'A machine provider got a key but has no backend yet: restart the gateway to enable it');
  const detail = [...r.rejected.map(x => `${x.provider}: ${x.error}`), ...r.needsRestart.map(p => `${p}: needs restart`)].join('; ');
  keyAudit.record({ actor: 'palco-reload', action: 'deployment-credentials.rotate', names: changed, ok: r.rejected.length === 0, ...(detail ? { detail } : {}) });
}
const keyManager = new KeyManager(process.env, {
  cachePath: sandboxCachePath,
  log: (msg, data) => log.log(data ?? {}, msg),
  onChange: async (names) => {
    keyAudit.record({ actor: 'palco-reload', action: 'provider-keys.applied', names, ok: true });
    await rotateDeploymentCredentials(names);
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
const adminWarning = adminListWarning(process.env);
if (adminWarning) log.warn({}, `WARNING: ${adminWarning}`);
const isAdminToken = (token: string) => {
  const userId = keyRegistry.resolve(token)?.userId;
  return Boolean(userId && adminUsers.has(userId));
};
const adminGate = new AdminGate({
  actorOf: (token) => { const userId = keyRegistry.resolve(token)?.userId; return userId && adminUsers.has(userId) ? userId : null; },
  audit: keyAudit,
});
// What a leaked non-admin app key can do (src/gateway/proxy/app-limits.ts): its app's own aliases only, max_tokens
// clamped (APP_MAX_TOKENS), daily budget (APP_DAILY_REQUESTS / APP_DAILY_TOKENS). Admin keys are never limited.
const appOfUser = (userId: string) => (userId === SANDBOX_USER ? process.env.SANDBOX_TOKEN_APP?.trim() || SANDBOX_USER : userId);
const appAliasesOf = (userId: string, stage: string): Set<string> | null => {
  const routes = deployments?.apps.get(appOfUser(userId))?.routes?.[stage as 'chat' | 'stt' | 'tts'];
  return routes ? new Set(Object.keys(routes)) : null;
};
const appLimits = keysConfigured() ? new AppLimits({
  env: process.env,
  statePath: join(process.env.DEPLOYMENTS_STATE_DIR || join(homedir(), '.ai-gateway'), 'app-budgets.json'),
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
  userOf: (req) => (keysConfigured() ? keyRegistry.resolve(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))?.userId ?? '' : null),
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
    isMasterKey: (token) => access.isSandboxToken(token),
    replica: (id) => controller?.replicaAuth(id) ?? null,
  },
  isAdminToken,
  log: (msg, data) => log.log(data ?? {}, msg),
});
if (telemetry) {
  await telemetry.start();
  latency = () => latencyReport(telemetry.store.rows(), Date.now());
  log.log({ rows: telemetry.store.size }, 'Telemetry enabled');
}

const modelPrices = createModelPrices({ path: join(stateDir, 'model-prices.json'), log: (msg, data) => log.warn(data ?? {}, msg) });
await modelPrices.load().catch((err: unknown) => log.warn({ error: err instanceof Error ? err.message : String(err) }, 'model prices: cache unreadable, starts empty'));
modelPrices.start();
setGatewayTelemetrySink((event, caller) => {
  const app = caller && appOfUser(caller);
  if (event.event !== 'usage.cost') { telemetry?.ingest.ingestOwn(event, app); return; }
  const cost = usageCost(event.attrs ?? {}, modelPrices.snapshot()?.models ?? {});
  spendLedger.cloud(app || NO_APP, cost?.usd ?? null, String(event.attrs?.stage ?? 'chat'), cost?.estimated);
  const attrs = { ...event.attrs };
  if (cost) Object.assign(attrs, { costUsd: cost.usd, estimated: cost.estimated });
  else attrs.costUnknown = true;
  telemetry?.ingest.ingestOwn({ ...event, attrs }, app);
});

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
  userOf: (req) => (keysConfigured() ? keyRegistry.resolve(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))?.userId ?? null : 'localhost'),
  isAdmin: (userId) => adminUsers.has(userId) || (!keysConfigured() && userId === 'localhost'),
  ...(appLimits ? { charge: (userId: string, n: number) => appLimits.chargeRequests(userId, n) } : {}),
  ...(deployments ? { devices: deployments.devices } : {}),
  ...(telemetry ? { telemetry: realtimeSinkToTelemetry(telemetry.ingest) } : {}),
  log: (msg, data) => log.log(data ?? {}, msg),
});
realtimeSessionOf = sessionResolverFrom(realtime.service);
if (deployments) deployments.devices.onBlock = (app, device) => { void realtime.service.endDeviceSessions(app, device); };
// Live subtitle rooms (src/rooms, docs/rooms.md): POST /v1/rooms with a gateway key; publishing with the room's own
// token, the transcript, the viewer WebSocket and the viewer pages (ROOMS_PUBLIC_HOST, /live/:code) mounted in front.
const rooms = createRooms({
  keyUser: (token) => {
    const userId = keyRegistry.resolve(token)?.userId;
    return userId ? { userId, admin: adminUsers.has(userId) } : null;
  },
  userOf: (req) => (keysConfigured() ? keyRegistry.resolve(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))?.userId ?? 'anonymous' : 'localhost'),
  log: (msg, data) => log.log(data ?? {}, msg),
  // Server dubbing (Kokoro 82M via OpenRouter, MAI-Voice when Kokoro is stuck or fails) for listeners of rooms whose
  // presenter sends text only. Each attempt is time-bounded: the OpenRouter SDK client has no timeout of its own.
  synthesize: synthesizeWithFallback([kokoroSynthesize(openrouterTTS), maiSynthesize(openrouterTTS)]),
  synthesizeAvailable: () => openrouterTTS.isConfigured(),
  translate: openRouterTranslate(openrouterLLM),
});
log.log({
  dir: rooms.config.dir, publicHost: rooms.config.publicHost, publicBaseUrl: rooms.config.publicBaseUrl,
  serverDub: rooms.config.serverDub && openrouterTTS.isConfigured(),
}, 'Rooms enabled');
// Desktop-app field telemetry (src/app-telemetry, docs/app-telemetry.md): opt-in batches from the ucast.me app with a
// gateway key, admin summary/listing. Day files on the same volume as rooms.
const appTelemetry = appTelemetryFromEnv(process.env, {
  userOf: (req) => (keysConfigured() ? keyRegistry.resolve(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))?.userId ?? 'anonymous' : 'localhost'),
  isAdminToken,
  log: (msg, data) => log.log(data ?? {}, msg),
});
if (appTelemetry) {
  await appTelemetry.start();
  setInterval(() => opsAlerts.fromVoiceTurns(appTelemetry.voiceTurns()), 30_000).unref();
  log.log({ dir: appTelemetry.store.dir, retentionDays: appTelemetry.store.retentionDays }, 'App telemetry enabled');
}

const deviceGate = deployments && ((userId: string, headers: import('http').IncomingHttpHeaders, kind: string) => {
  const named = typeof headers['x-app'] === 'string' ? headers['x-app'].trim() : null;
  return deployments.devices.admit(adminUsers.has(userId) ? named : userId, headers[DEVICE_HEADER], kind);
});

const ttsCache = ttsCacheFromEnv(process.env, stateDir);
await ttsCache?.load().catch((err: unknown) => log.warn({ error: err instanceof Error ? err.message : String(err) }, 'TTS cache: disk tier unreadable, memory only'));

const server = await startProxy({
  port: PORT,
  hostname: '0.0.0.0',
  apiKeys: API_KEYS,
  keyRegistry,
  providers,
  deepHealth,
  autoWake: (bearer) => !keysConfigured()
    || autoWakesNow(access.policyOf(access.resolve(bearer)?.keyId), classWindowOpen(deployments?.controller.list() ?? [], Date.now())),
  ...(deployments ? { mayWake: (bearer: string, deployment: string) => {
    const key = access.resolve(bearer);
    return deployments.clientGpu.requestMayWake(key && { keyId: key.keyId, user: key.userId }, access.policyOf(key?.keyId), deployment);
  } } : {}),
  countsAsUse: (bearer) => access.policyOf(access.resolve(bearer)?.keyId).countsAsUse,
  ...(ttsCache ? { ttsCache: { cache: ttsCache, requiresGpu: (userId: string) => deployments?.apps.get(appOfUser(userId))?.profile?.requiresGpu === true } } : {}),
  ...(appLimits ? { appLimits } : {}),
  ...(deviceGate ? { deviceGate } : {}),
  onInference: (event) => {
    accounts?.recordInference(event);
    if (event.status >= 400) return;
    const fields = event.body && typeof event.body === 'object' && !Array.isArray(event.body) ? event.body as Record<string, unknown> : {};
    spendLedger.request(appOfUser(event.userId), event.kind === 'chat' ? llmTokensOf(fields, event.response) : 0);
  },
  ...(deployments ? { onServed: ({ userId, kind, status, headers }) => deployments.gpuHealth.served(appOfUser(userId), kind, status, headers) } : {}),
  // GET /health?details=1: an admin sees every chain, an app key the chains of its own aliases (health-view.ts).
  healthDetails: (viewer) => (viewer.admin
    ? { images: buildImages(), providerCredit: controller?.creditIssues() ?? [], balances: balanceWatch.snapshot(), fallbackProbe: fallbackProbe.snapshot(), ...chainHealth(), turn: realtime.service.turnHealth(), realtime: realtimeHealth(controller?.list() ?? []), streams: streamCuts(), appBudgets: appLimits?.budgets() ?? [], clientGpu: deployments?.clientGpu.report() ?? null }
    : { ...appStagesView(chainsNow(), (stage) => appAliasesOf(viewer.userId, stage)), appBudgets: appLimits?.budgets(viewer.userId) ?? [], clientGpu: deployments?.clientGpu.report(viewer.userId) ?? null }),
  customRoutes: [
    ...createKeyAdminRoutes(keyManager, adminGate), ...createAccessRoutes({ access, gate: adminGate, audit: keyAudit, deployments: controller }), { method: 'POST', path: '/v1/s2s', handler: s2sRoute }, realtime.route, realtime.updateRoute,
    rooms.route, ...(appTelemetry?.routes ?? []), ...(telemetry?.adminRoutes ?? []),
    ...(benchmarks ? createModelBenchmarkRoutes({ store: benchmarks, gate: adminGate, onChange: () => remount?.() }) : []),
  ],
  publicRoutes: [...(telemetry?.publicRoutes ?? []), ...(controller ? [bootFilesRoute(controller), bootEventsRoute(controller)] : []), ...(machines ? [machines.reportRoute] : [])],
  ...(prefixRoutes.length > 0 ? { prefixRoutes } : {}),
  ...(upgradeRoutes.length > 0 ? { upgradeRoutes } : {}),
  ...(RATE_LIMIT_RPM > 0 ? { rateLimit: { rpm: RATE_LIMIT_RPM } } : {}),
});

realtime.mount(server);
rooms.mount(server);
// Outermost: the account API and pages answer themselves, and the quota gate sees every metered request first.
accounts?.mount(server);
const adminSnapshot = (): AdminSnapshot => ({
  reserves: fallbackProbe.snapshot(), balances: balanceWatch.snapshot().readings, providerCredit: controller?.creditIssues() ?? [],
  gpus: controller?.list() ?? null, gpuValidation: deployments?.gpuValidation.views() ?? {},
  gpuLogs: Object.fromEntries((controller?.list() ?? []).map(d => [d.name, controller!.bootLog(d.name)])), gpuSpend: deployments?.clientGpu.report() ?? null, alerts: alertLog.list(),
  machines: machines?.controller.costs(null) ?? null, keys: access.list(), appBudgets: appLimits?.budgets() ?? [],
  apps: deployments?.apps.list().map(({ id }) => {
    const entry = deployments.apps.get(id);
    return {
      id, profile: entry?.profile ?? null, status: deployments.gpuHealth.status(id), aliases: Object.values(entry?.routes ?? {}).flatMap(r => Object.keys(r ?? {})),
      stages: Object.fromEntries(Object.entries(entry?.routes ?? {}).map(([stage, r]) => [stage, Object.keys(r ?? {})])),
      routes: entry?.routes,
    };
  }) ?? [],
  traffic: telemetry ? adminTraffic(telemetry.store.rows(), Date.now()) : null, audit: keyAudit.recent(30),
  spend: spendLedger.view(), dismissed: spendLedger.dismissed(), chains: chainsNow().stages,
  about: {
    commit: (minimalHealth().commit as string | null) ?? null, uptimeSeconds: Math.round(process.uptime()),
    region: process.env.RAILWAY_REPLICA_REGION?.trim() || null,
    telemetryAt: telemetry ? (() => { const rows = telemetry.store.rows(); return rows.length ? new Date(rows[rows.length - 1]!.rxTs).toISOString() : null; })() : null,
  },
  digest: suggestionDigest.status(), overspend: overspendWatch.active(), reorders: reorderSnapshot(), ttsCache: ttsCache?.stats() ?? null,
  modelPrices: modelPrices.snapshot(),
  voiceTurns: appTelemetry?.voiceTurns() ?? null,
  incidents: incidents.list(),
});

const overspendWatch = createOverspendWatch({
  input: () => ({
    spend: spendLedger.view(), gpus: controller?.list() ?? [], keys: access.list(), gpuSpend: deployments?.clientGpu.report() ?? null,
    machines: machines?.controller.costs(null) ?? null, rows: telemetry?.store.rows() ?? [], appOf: ownerOfDeployment,
  }),
  notify: (o, mail) => {
    log.warn({ id: o.id, value: o.value, normal: o.normal }, `ALERT spend.over ${o.who}`);
    alertLog.record('spend.over', { quem: o.who, gasto: o.text, projecao: o.projection, causa: o.cause });
    void alertMailer?.deliver(mail);
    return alertWebhook?.send({ event: 'spend.over', data: { id: o.id, who: o.who, app: o.app, value: o.value, normal: o.normal, projection: o.projection, cause: o.cause } });
  },
  classOpen: () => classWindowOpen(controller?.list() ?? [], Date.now()),
  baseUrl: panelBaseUrl,
  limits: overspendLimitsFromEnv(process.env),
  log: (msg, data) => log.warn(data ?? {}, msg),
});
overspendWatch.start();

const suggestionDigest = createSuggestionDigest({
  list: () => recommendations({ s: adminSnapshot(), now: Date.now(), csrf: '', app: null, view: null }),
  deliver: alertMailer && process.env.SUGGESTION_DIGEST?.trim() !== '0' ? (mail) => alertMailer.deliver(mail) : null,
  classOpen: () => classWindowOpen(controller?.list() ?? [], Date.now()),
  baseUrl: panelBaseUrl,
  path: join(stateDir, 'suggestion-digest.json'),
  log: (msg, data) => log.log(data ?? {}, msg),
});
await suggestionDigest.load().catch((err: unknown) => log.error({ error: err instanceof Error ? err.message : String(err) }, 'SUGGESTION DIGEST STATE UNREADABLE: starts empty'));
suggestionDigest.start();

// GET /admin: the status page for a browser, signed in once with the admin key or an app's own key (src/admin-page).
createAdminPage({
  actorOf: (key) => {
    const userId = keyRegistry.resolve(key)?.userId;
    if (!userId) return null;
    if (adminUsers.has(userId)) return { name: userId, app: null };
    if (!deployments?.apps.get(userId)) return null;
    const keyId = access.resolve(key)?.keyId;
    return { name: userId, app: userId, ...(keyId ? { keyId, mayPark: () => access.policyOf(keyId).canStartGpu } : {}) };
  },
  snapshot: adminSnapshot,
  dismiss: (id) => spendLedger.dismiss(id),
  sendDigest: () => suggestionDigest.sendNow(),
  park: async (name, actor) => {
    if (!controller) throw new Error('deployments desligados');
    if (actor.keyId) await deployments?.clientGpu.forget(actor.keyId, name);
    await controller.park(name);
    incidents.action('park', name, `painel: ${actor.name}`);
  },
  pin: async (name, on) => {
    const spec = controller?.specOf(name);
    if (!spec) throw new Error(`deployment '${name}' não existe`);
    if (spec.provider !== 'vast') throw new Error('só uma GPU da Vast pode ser fixada pelo painel');
    await controller!.put(name, { minReplicas: on ? 1 : 0 });
  },
  gpuType: async (name, machineType, now, actor) => {
    if (!deployments) throw new Error('deployments desligados');
    await deployments.gpuValidation.setGpuType(name, machineType, now, actor);
  },
  gpuTest: async (name, machineType, actor) => {
    if (!deployments) throw new Error('deployments desligados');
    await deployments.gpuValidation.startTrial(name, machineType, actor);
  },
  probe: () => fallbackProbe.check(),
  secrets: () => secretValues(process.env),
  containerLog: async (name) => controller?.containerLog(name) ?? null,
  audit: (entry) => keyAudit.record(entry),
}).mount(server);

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
    const stateWritten = Promise.all([deployments?.controller.stop(), machines?.controller.stop(), accounts?.stop(), spendLedger.stop(), bootHistory?.stop(), deployments?.gpuValidation.stop()]);
    const exit = (code: number) => void stateWritten.finally(() => process.exit(code));
    void deployments?.devices.flush().catch(() => {});
    realtime.stop();
    rooms.stop();
    appTelemetry?.stop();
    declared?.stop();
    deployments?.clientGpu.stop();
    deployments?.gpuHealth.probe.stop();
    balanceWatch.stop();
    suggestionDigest.stop();
    overspendWatch.stop();
    fallbackProbe.stop();
    keyManager.stop();
    void access.stop();
    void keyAudit.flush();
    telemetry?.stop();
    void appLimits?.flush();
    setGatewayTelemetrySink(null);
    console.log(`[serve] Received ${signal}, draining ${activeRequests} active request(s)...`);

    // Stop accepting new connections
    server.close(() => {
      console.log('[serve] All connections drained. Exiting.');
      exit(0);
    });

    // Poll active requests — exit early if all drained
    const drainCheck = setInterval(() => {
      if (activeRequests <= 0) {
        clearInterval(drainCheck);
        console.log('[serve] All requests completed. Exiting.');
        exit(0);
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
