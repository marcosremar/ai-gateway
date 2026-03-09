/**
 * GPU Autoscaler route handlers — pure business logic, no framework dependencies.
 *
 * These functions are called by thin Next.js route wrappers that provide
 * auth (userId) and convert HandlerResult to NextResponse.
 */
import type { HandlerDeps, HandlerResult } from './types';
import { ok, err } from './types';
import type { AutoScalerConfig } from '../types';
import { PROVIDER_BOOT_SECS } from '../factory';
import { AutoscalerSettingsSchema } from './autoscaler-schemas';
import { ModalClient } from '../gpu-providers/modal-client';
import { runHealthCheck, runSSEBench } from '../benchmarking/bench';

type LoadConfig = (userId: string) => Promise<AutoScalerConfig | null>;

const VALID_PROVIDERS = ['tensordock', 'runpod', 'vast', 'modal'];

// ── GET handler ─────────────────────────────────────────────────────────────

export async function handleAutoscalerGet(
  deps: HandlerDeps,
  userId: string,
  loadConfig: LoadConfig,
  readOwnAutoscaler?: () => Promise<Record<string, unknown> | undefined>,
): Promise<HandlerResult> {
  const { autoscaler, signGpuToken } = deps;

  // Read user's own autoscaler config (may differ from resolveUserSettings for teachers)
  const ownAutoscaler = readOwnAutoscaler ? await readOwnAutoscaler() : undefined;

  const config = await loadConfig(userId);

  // Auto-reconcile stale machines (fire-and-forget, rate-limited to every 10min)
  autoscaler.scheduleReconcile(userId);
  if (config) autoscaler.scheduleWatchdog(userId, config);

  // If loadAutoscalerConfig returns null but user has autoscaler enabled in own settings,
  // return the user's own config so the card reflects their saved state
  const effectiveEnabled = config?.enabled || !!ownAutoscaler?.enabled;

  if (!config) {
    return ok({
      enabled: effectiveEnabled,
      route: 'llm',
      reason: effectiveEnabled ? 'Autoscaling ativado — nenhum tier S2S GPU configurado' : 'Autoscaling não configurado',
      activeSessions: 0,
      threshold: (ownAutoscaler?.threshold as number) ?? 5,
      maxLatencyMs: (ownAutoscaler?.maxLatencyMs as number) ?? 1500,
      windowMinutes: (ownAutoscaler?.windowMinutes as number) ?? 10,
      p95LatencyMs: null,
      gpuState: 'idle',
    });
  }

  const decision = await autoscaler.getAutoScaleDecision(userId, config);

  // Sign a short-lived HMAC token when routing to GPU
  let gpuToken: string | undefined;
  try {
    if (decision.route === 's2s' && decision.endpoint && signGpuToken) {
      gpuToken = signGpuToken(userId);
    }
  } catch { /* GPU_ACCESS_SECRET not set — skip token */ }

  return ok({
    ...decision,
    ...(gpuToken ? { gpuToken } : {}),
    windowMinutes: config.windowMinutes,
    ...(Array.isArray(config.gpuTypes) ? { gpuTypes: config.gpuTypes } : {}),
  });
}

// ── POST handler ────────────────────────────────────────────────────────────

export async function handleAutoscalerAction(
  deps: HandlerDeps,
  userId: string,
  action: string,
  body: Record<string, unknown>,
  loadConfig: LoadConfig,
): Promise<HandlerResult> {
  const { autoscaler, settingsStore, credentialStore } = deps;

  switch (action) {
    case 'save-config': {
      const { enabled, threshold, windowMinutes, gpuProvider, maxLatencyMs, tiers, gpuTypes, idleGraceMinutes } = body;

      if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
        return err('threshold deve ser entre 1 e 100');
      }
      if (maxLatencyMs !== undefined && (typeof maxLatencyMs !== 'number' || maxLatencyMs < 500)) {
        return err('maxLatencyMs deve ser >= 500ms');
      }

      const autoscalerConfig = AutoscalerSettingsSchema.parse({
        enabled: Boolean(enabled),
        threshold: Number(threshold),
        windowMinutes: Number(windowMinutes ?? 10),
        maxLatencyMs: Number(maxLatencyMs ?? 1500),
        gpuProvider: gpuProvider ?? 'tensordock',
        idleGraceMinutes: Number(idleGraceMinutes ?? 15),
        ...(Array.isArray(tiers) && tiers.length > 0 ? { tiers } : {}),
        ...(Array.isArray(gpuTypes) ? { gpuTypes } : {}),
      });

      await settingsStore.patch(userId, { autoscaler: autoscalerConfig });
      autoscaler.resetGpuState(userId);
      return ok({ success: true });
    }

    case 'pool-status': {
      const states = autoscaler.getPoolStatus(userId);
      const config = await loadConfig(userId);
      const tierList = states.map((ts, i: number) => ({
        ...ts,
        provider: config?.tiers?.[i]?.provider ?? null,
        instanceId: config?.tiers?.[i]?.instanceId ?? null,
        configEndpoint: config?.tiers?.[i]?.endpoint ?? null,
        gpuTypes: config?.tiers?.[i]?.gpuTypes ?? null,
      }));
      return ok({
        tiers: tierList,
        config: config ? {
          enabled: config.enabled,
          threshold: config.threshold,
          windowMinutes: config.windowMinutes,
          maxLatencyMs: config.maxLatencyMs,
          totalTiers: config.tiers?.length ?? 0,
          providerBootSecs: Object.fromEntries(
            [...new Set((config.tiers ?? []).map(t => t.provider))].map(p => [p, PROVIDER_BOOT_SECS[p] ?? 120])
          ),
        } : null,
      });
    }

    case 'report-session': {
      const { sessionKey } = body;
      if (typeof sessionKey === 'string' && sessionKey.length > 0) {
        await autoscaler.reportSessionHeartbeat(userId, sessionKey);
      }
      return ok({ success: true });
    }

    case 'report-latency': {
      const { totalMs } = body;
      if (typeof totalMs === 'number' && totalMs > 0) {
        await autoscaler.reportLatency(userId, totalMs);
      }
      return ok({ success: true });
    }

    case 'reset': {
      autoscaler.resetGpuState(userId);
      return ok({ success: true, message: 'Estado da GPU reiniciado' });
    }

    case 'force-ready': {
      const { endpoint } = body;
      if (!endpoint) return err('endpoint is required');
      autoscaler.forceGpuReady(userId, endpoint as string);
      return ok({ success: true, message: 'GPU marcada como pronta' });
    }

    case 'get-decision': {
      const config = await loadConfig(userId);
      autoscaler.scheduleReconcile(userId);
      if (config) autoscaler.scheduleWatchdog(userId, config);
      if (!config) {
        return ok({
          enabled: false,
          route: 'llm',
          reason: 'Autoscaling não configurado',
          activeSessions: 0,
          threshold: 5,
          maxLatencyMs: 1500,
          p95LatencyMs: null,
          gpuState: 'idle',
        });
      }
      const dec = await autoscaler.getAutoScaleDecision(userId, config);
      let tok: string | undefined;
      try {
        if (dec.route === 's2s' && dec.endpoint && deps.signGpuToken) tok = deps.signGpuToken(userId);
      } catch { /* GPU_ACCESS_SECRET not set */ }
      return ok({ ...dec, ...(tok ? { gpuToken: tok } : {}) });
    }

    case 'lifecycle-logs': {
      const { limit = 50, eventType, provider, sortOrder = 'desc' } = body;
      const order = sortOrder === 'asc' ? 'asc' : 'desc';

      const userIds = deps.userRoleResolver
        ? await deps.userRoleResolver.resolveVisibleUserIds(userId)
        : [userId];

      if (!deps.lifecycleLogStore) {
        return err('Lifecycle log store not configured', 500);
      }

      const events = await deps.lifecycleLogStore.query({
        userIds,
        eventType: eventType ? String(eventType) : undefined,
        provider: provider ? String(provider) : undefined,
        limit: Math.min(Number(limit) || 50, 200),
        sortOrder: order as 'asc' | 'desc',
      });
      return ok({ events });
    }

    case 'destroy-all': {
      const config = await loadConfig(userId);
      const results: Array<{ tier: number; ok: boolean; error?: string }> = [];

      if (config?.tiers) {
        for (let i = 0; i < config.tiers.length; i++) {
          const result = await autoscaler.deleteTier(userId, i);
          results.push({ tier: i, ok: result.ok, error: result.error });
        }
      }

      autoscaler.resetGpuState(userId);
      return ok({ success: true, destroyed: results });
    }

    // ── Tier Lifecycle Management ──────────────────────────────────────────

    case 'stop-tier': {
      const { tierIndex } = body;
      if (typeof tierIndex !== 'number') return err('tierIndex is required');
      const result = await autoscaler.stopTier(userId, tierIndex);
      return ok(result);
    }

    case 'stop-all-tiers': {
      // Mark ALL tiers as manually stopped — prevents auto-reboot.
      // Used by frontend after SkyPilot stop or any external cluster shutdown.
      const config = await loadConfig(userId);
      const results: Array<{ tier: number; ok: boolean; error?: string }> = [];
      if (config?.tiers) {
        for (let i = 0; i < config.tiers.length; i++) {
          const result = await autoscaler.stopTier(userId, i);
          results.push({ tier: i, ok: result.ok, error: result.error });
        }
      }
      return ok({ success: true, results });
    }

    case 'start-tier': {
      const { tierIndex } = body;
      if (typeof tierIndex !== 'number') return err('tierIndex is required');
      const result = await autoscaler.startTier(userId, tierIndex);
      return ok(result);
    }

    case 'delete-tier': {
      const { tierIndex } = body;
      if (typeof tierIndex !== 'number') return err('tierIndex is required');
      const result = await autoscaler.deleteTier(userId, tierIndex);
      return ok(result);
    }

    case 'restart-tier': {
      const { tierIndex } = body;
      if (typeof tierIndex !== 'number') return err('tierIndex is required');
      const result = await autoscaler.restartTier(userId, tierIndex);
      return ok(result);
    }

    case 'deploy-tier': {
      const { tierIndex } = body;
      if (typeof tierIndex !== 'number') return err('tierIndex is required');
      const result = await autoscaler.deployTier(userId, tierIndex);
      return ok(result);
    }

    case 'tier-detail': {
      const { tierIndex } = body;
      if (typeof tierIndex !== 'number') return err('tierIndex is required');
      const detail = await autoscaler.getTierDetail(userId, tierIndex);
      if (!detail) return err('Tier not found');
      return ok(detail);
    }

    case 'all-tier-details': {
      const details = await autoscaler.getAllTierDetails(userId);
      return ok({ tiers: details });
    }

    // ── Benchmark Tracking ─────────────────────────────────────────────────

    case 'report-inference-benchmark': {
      const { provider, endpoint, sttMs, llmMs, ttsMs, totalMs, ttfaMs } = body;
      if (typeof totalMs !== 'number') return err('totalMs is required');
      await autoscaler.reportInferenceBenchmark({
        userId,
        provider: (provider as string) ?? 'unknown',
        endpoint: (endpoint as string) ?? '',
        sttMs: sttMs as number | undefined,
        llmMs: llmMs as number | undefined,
        ttsMs: ttsMs as number | undefined,
        totalMs: totalMs as number,
        ttfaMs: ttfaMs as number | undefined,
        timestamp: Date.now(),
      });
      return ok({ success: true });
    }

    case 'benchmark-summary': {
      const { date } = body;
      const summary = await autoscaler.getBenchmarkSummary(userId, date as string | undefined);
      return ok(summary);
    }

    case 'benchmark-trend': {
      const { days } = body;
      const trend = await autoscaler.getBenchmarkTrend(userId, typeof days === 'number' ? days : 7);
      return ok(trend);
    }

    // ── Modal GPU Management ──────────────────────────────────────────────

    case 'modal-deploy': {
      const { deployFile, gpuTypes: bodyGpuTypes, apiKey: bodyApiKey } = body;
      const creds = bodyApiKey
        ? { apiKey: bodyApiKey as string }
        : await credentialStore.resolve(userId, 'modal');
      if (!creds) return err('Modal API key not configured');

      if (!deployFile) return err('deployFile is required — no default deploy path allowed');
      const modalClient = new ModalClient();
      const file = deployFile as string;
      const instance = await modalClient.createInstance(
        { gpuTypes: Array.isArray(bodyGpuTypes) ? bodyGpuTypes as string[] : [], dockerImage: file },
        creds,
      );

      // Persist the modal instance info in user settings
      await settingsStore.patch(userId, {
        modalInstance: {
          appId: instance.instanceId,
          appName: instance.instanceName,
          endpoint: instance.endpoint,
          status: instance.status,
          deployFile: file,
        },
      });

      return ok({
        success: true,
        instance: {
          appId: instance.instanceId,
          appName: instance.instanceName,
          endpoint: instance.endpoint,
          status: instance.status,
        },
      });
    }

    case 'modal-status': {
      const { apiKey: bodyApiKey } = body;
      const creds = bodyApiKey
        ? { apiKey: bodyApiKey as string }
        : await credentialStore.resolve(userId, 'modal');
      if (!creds) return err('Modal API key not configured');

      const modalClient = new ModalClient();
      const instances = await modalClient.listInstances(creds);

      return ok({
        success: true,
        instances: instances.map(i => ({
          appId: i.instanceId,
          appName: i.instanceName,
          endpoint: i.endpoint,
          status: i.status,
        })),
      });
    }

    case 'modal-stop': {
      const { appId, apiKey: bodyApiKey } = body;
      if (!appId) return err('appId is required');

      const creds = bodyApiKey
        ? { apiKey: bodyApiKey as string }
        : await credentialStore.resolve(userId, 'modal');
      if (!creds) return err('Modal API key not configured');

      const modalClient = new ModalClient();
      await modalClient.stopInstance(appId as string, creds);

      // Update persisted status
      await settingsStore.patch(userId, {
        modalInstance: { status: 'stopped' },
      });

      return ok({ success: true, message: `App ${appId} stopped` });
    }

    // ── Direct Instance Lifecycle (provider-level, not tier-bound) ─────────

    case 'instance-list': {
      const { provider } = body;
      if (!provider || !VALID_PROVIDERS.includes(provider as string)) {
        return err(`provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
      }

      const creds = await credentialStore.resolve(userId, provider as string);
      if (!creds) return err(`No API key found for ${provider}. Set it in Settings or via env var.`);

      const client = autoscaler.registry.getOrThrow(provider as string);

      const instances = await client.listInstances(creds);
      return ok({ provider, instances });
    }

    case 'instance-create': {
      const { provider, gpuTypes, dockerImage, env } = body;
      if (!provider || !VALID_PROVIDERS.includes(provider as string)) {
        return err(`provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
      }

      const creds = await credentialStore.resolve(userId, provider as string);
      if (!creds) return err(`No API key found for ${provider}`);

      const client = autoscaler.registry.get(provider as string);
      if (!client) return err(`Provider ${provider} not registered`);

      const instance = await client.createInstance(
        {
          gpuTypes: Array.isArray(gpuTypes) ? gpuTypes as string[] : ['RTX_3090', 'RTX_4090'],
          dockerImage: dockerImage as string | undefined,
          env: env as Record<string, string> | undefined,
          hfToken: creds.hfToken,
        },
        creds,
        userId,
      );

      return ok({ provider, instance });
    }

    case 'instance-start': {
      const { provider, instanceId } = body;
      if (!provider || !instanceId) return err('provider and instanceId are required');
      if (!VALID_PROVIDERS.includes(provider as string)) return err(`Invalid provider: ${provider}`);

      const creds = await credentialStore.resolve(userId, provider as string);
      if (!creds) return err(`No API key found for ${provider}`);

      const client = autoscaler.registry.get(provider as string);
      if (!client) return err(`Provider ${provider} not registered`);

      await client.startInstance(String(instanceId), creds);
      return ok({ success: true, provider, instanceId, action: 'start' });
    }

    case 'instance-stop': {
      const { provider, instanceId } = body;
      if (!provider || !instanceId) return err('provider and instanceId are required');
      if (!VALID_PROVIDERS.includes(provider as string)) return err(`Invalid provider: ${provider}`);

      const creds = await credentialStore.resolve(userId, provider as string);
      if (!creds) return err(`No API key found for ${provider}`);

      const client = autoscaler.registry.get(provider as string);
      if (!client) return err(`Provider ${provider} not registered`);

      await client.stopInstance(String(instanceId), creds);
      return ok({ success: true, provider, instanceId, action: 'stop' });
    }

    case 'instance-delete': {
      const { provider, instanceId } = body;
      if (!provider || !instanceId) return err('provider and instanceId are required');
      if (!VALID_PROVIDERS.includes(provider as string)) return err(`Invalid provider: ${provider}`);

      const creds = await credentialStore.resolve(userId, provider as string);
      if (!creds) return err(`No API key found for ${provider}`);

      const client = autoscaler.registry.get(provider as string);
      if (!client) return err(`Provider ${provider} not registered`);

      await client.deleteInstance(String(instanceId), creds);
      return ok({ success: true, provider, instanceId, action: 'delete' });
    }

    case 'instance-status': {
      const { provider, instanceId } = body;
      if (!provider || !instanceId) return err('provider and instanceId are required');
      if (!VALID_PROVIDERS.includes(provider as string)) return err(`Invalid provider: ${provider}`);

      const creds = await credentialStore.resolve(userId, provider as string);
      if (!creds) return err(`No API key found for ${provider}`);

      const client = autoscaler.registry.get(provider as string);
      if (!client) return err(`Provider ${provider} not registered`);

      const status = await client.getInstanceStatus(String(instanceId), creds);
      let endpoint: string | null = null;
      if (client.resolveInstanceEndpoint) {
        try {
          endpoint = await client.resolveInstanceEndpoint(String(instanceId), creds);
        } catch { /* endpoint resolution failed */ }
      }
      return ok({ provider, instanceId, status, endpoint });
    }

    // ── Persistent Benchmarks (via BenchmarkStore) ──────────────────────────

    case 'benchmark-health': {
      const { endpoint, provider: benchProvider } = body;
      if (!endpoint) return err('endpoint is required');
      if (!deps.benchmarkStore) return err('Benchmark store not configured', 500);

      const base = String(endpoint).replace(/\/$/, '');
      const result = await runHealthCheck(base);

      await deps.benchmarkStore.create({
        userId,
        provider: (benchProvider as string) ?? 'unknown',
        benchType: 'health',
        endpoint: base,
        success: result.ok,
        totalMs: result.latency_ms,
        healthMs: result.ok ? result.latency_ms : null,
        error: result.error ?? null,
        metadata: result.data ?? undefined,
      });

      return ok({ ...result, persisted: true });
    }

    case 'benchmark-inference': {
      const { endpoint, provider: benchProvider } = body;
      if (!endpoint) return err('endpoint is required');
      if (!deps.benchmarkStore) return err('Benchmark store not configured', 500);

      const base = String(endpoint).replace(/\/$/, '');

      const health = await runHealthCheck(base);
      if (!health.ok) {
        await deps.benchmarkStore.create({
          userId,
          provider: (benchProvider as string) ?? 'unknown',
          benchType: 'inference',
          endpoint: base,
          success: false,
          error: `Health check failed: ${health.error}`,
          protocol: 'sse',
        });
        return ok({ ok: false, error: `Health check failed: ${health.error}`, health });
      }

      const result = await runSSEBench(base);

      await deps.benchmarkStore.create({
        userId,
        provider: (benchProvider as string) ?? 'unknown',
        benchType: 'inference',
        endpoint: base,
        success: result.ok,
        totalMs: result.total_ms,
        ttfaMs: result.ttfa_ms ?? null,
        sttMs: result.stt_ms ?? null,
        llmMs: result.llm_ms ?? null,
        ttsMs: result.tts_ms ?? null,
        protocol: 'sse',
        error: result.error ?? null,
        metadata: {
          transcript: result.transcript,
          response: result.response,
          healthLatencyMs: health.latency_ms,
        },
      });

      return ok({ ...result, health, persisted: true });
    }

    case 'benchmark-boot': {
      const { provider, gpuTypes, dockerImage, deleteAfter } = body;
      if (!provider || !VALID_PROVIDERS.includes(provider as string)) {
        return err(`provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
      }
      if (!deps.benchmarkStore) return err('Benchmark store not configured', 500);

      const creds = await credentialStore.resolve(userId, provider as string);
      if (!creds) return err(`No API key found for ${provider}`);

      const client = autoscaler.registry.get(provider as string);
      if (!client) return err(`Provider ${provider} not registered`);

      const bootStart = Date.now();
      let instance;
      try {
        instance = await client.createInstance(
          {
            gpuTypes: Array.isArray(gpuTypes) ? gpuTypes as string[] : ['RTX_3090', 'RTX_4090'],
            dockerImage: dockerImage as string | undefined,
            hfToken: creds.hfToken,
          },
          creds,
          userId,
        );
      } catch (e) {
        const error = (e as Error).message;
        await deps.benchmarkStore.create({
          userId, provider, benchType: 'boot', success: false, error: `Create failed: ${error}`,
        });
        return ok({ ok: false, phase: 'create', error });
      }

      // Poll health until ready (max 40 min for cold start)
      const MAX_POLL_MS = 40 * 60 * 1000;
      const POLL_INTERVAL = 15_000;
      const pollStart = Date.now();
      let healthy = false;
      let healthLatency: number | undefined;

      while (Date.now() - pollStart < MAX_POLL_MS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        try {
          const h = await runHealthCheck(instance.endpoint);
          if (h.ok) {
            healthy = true;
            healthLatency = h.latency_ms;
            break;
          }
        } catch { /* continue polling */ }
      }

      const bootMs = Date.now() - bootStart;

      await deps.benchmarkStore.create({
        userId,
        provider,
        benchType: 'boot',
        instanceId: instance.instanceId,
        endpoint: instance.endpoint,
        success: healthy,
        totalMs: bootMs,
        bootMs: healthy ? bootMs : null,
        healthMs: healthLatency ?? null,
        gpuType: instance.gpuType ?? null,
        error: healthy ? null : `Boot timeout after ${Math.round(bootMs / 1000)}s`,
        metadata: { deleteAfter: !!deleteAfter },
      });

      if (deleteAfter) {
        try {
          await client.stopInstance(instance.instanceId, creds);
          await client.deleteInstance(instance.instanceId, creds);
        } catch { /* best-effort cleanup */ }
      }

      return ok({
        ok: healthy,
        provider,
        instanceId: instance.instanceId,
        endpoint: instance.endpoint,
        bootMs: healthy ? bootMs : null,
        healthLatencyMs: healthLatency,
        gpuType: instance.gpuType,
        deleted: !!deleteAfter,
        persisted: true,
      });
    }

    case 'benchmark-list': {
      const { benchType, provider: filterProvider, limit = 50 } = body;
      if (!deps.benchmarkStore) return err('Benchmark store not configured', 500);

      const benchmarks = await deps.benchmarkStore.query({
        userId,
        benchType: benchType ? String(benchType) : undefined,
        provider: filterProvider ? String(filterProvider) : undefined,
        limit: Math.min(Number(limit) || 50, 200),
      });

      return ok({ benchmarks });
    }

    // ── Deploy Sessions ──────────────────────────────────────────────────

    case 'create-deploy-session': {
      if (!deps.deploySessionStore) return err('Deploy session store not configured', 500);
      const { provider: p, gpuModel: gm, dockerImage: di, region: rg } = body;
      const sessionId = await deps.deploySessionStore.create({
        userId,
        provider: String(p ?? 'unknown'),
        gpuModel: String(gm ?? 'unknown'),
        dockerImage: di ? String(di) : undefined,
        region: rg ? String(rg) : undefined,
      });
      return ok({ sessionId });
    }

    case 'update-deploy-session': {
      if (!deps.deploySessionStore) return err('Deploy session store not configured', 500);
      const { id: sessionId, ...updateData } = body;
      if (!sessionId) return err('id is required');
      const mapped: Record<string, unknown> = {};
      if (updateData.status) mapped.status = String(updateData.status);
      if (updateData.serverReadyAt) mapped.serverReadyAt = new Date(String(updateData.serverReadyAt));
      if (updateData.stoppedAt) mapped.stoppedAt = new Date(String(updateData.stoppedAt));
      if (updateData.provisionTimeS != null) mapped.provisionTimeS = Number(updateData.provisionTimeS);
      if (updateData.errorMessage) mapped.errorMessage = String(updateData.errorMessage);
      if (updateData.providerInstanceId) mapped.providerInstanceId = String(updateData.providerInstanceId);
      if (updateData.endpoint) mapped.endpoint = String(updateData.endpoint);
      if (updateData.metadata && typeof updateData.metadata === 'object') mapped.metadata = updateData.metadata as Record<string, unknown>;
      await deps.deploySessionStore.update(String(sessionId), mapped);
      return ok({ success: true });
    }

    case 'deploy-sessions': {
      if (!deps.deploySessionStore) return err('Deploy session store not configured', 500);
      const userIds = deps.userRoleResolver
        ? await deps.userRoleResolver.resolveVisibleUserIds(userId)
        : [userId];
      const sessions = await deps.deploySessionStore.query({
        userIds,
        limit: Math.min(Number(body.limit) || 10, 100),
        sortOrder: 'desc',
      });
      return ok({ sessions });
    }

    default:
      return err(`Ação desconhecida: ${action}`);
  }
}
