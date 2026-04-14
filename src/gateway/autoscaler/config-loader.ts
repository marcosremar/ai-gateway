import type { AutoScalerConfig, GpuTierConfig, GpuProvider } from '../../types';
import type { SettingsStore, Logger } from '../../deps';
import { z } from 'zod';
import { defaultLogger } from '../../logger';

// ── Zod Schemas ────────────────────────────────────────────────────────────

const GpuTierSchema = z.object({
  provider: z.string(),
  instanceId: z.string().optional(),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  authId: z.string().optional(),
  gpuTypes: z.array(z.string()).optional(),
  hfToken: z.string().optional(),
  dockerImage: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  storageGb: z.number().optional(),
});

const AutoscalerSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  threshold: z.number().default(5),
  windowMinutes: z.number().default(10),
  maxLatencyMs: z.number().default(1500),
  idleGraceMinutes: z.number().default(15),
  gpuTypes: z.array(z.string()).optional(),
  gpuProvider: z.string().optional(),
  tiers: z.array(GpuTierSchema).optional(),
  dynamicInstances: z.array(z.record(z.string(), z.unknown())).optional(),
  loadBalanceStrategy: z.string().optional(),
  fallbackChains: z.array(z.unknown()).optional(),
  predictiveWarmup: z.record(z.string(), z.unknown()).optional(),
});

const InstanceSchema = z.object({
  instanceId: z.string().optional(),
  endpoint: z.string().optional(),
  podId: z.string().optional(),
  directUrl: z.string().optional(),
});

const SkypilotSchema = z.object({
  tensordockApiKey: z.string().optional(),
  tensordockAuthId: z.string().optional(),
  runpodApiKey: z.string().optional(),
  vastApiKey: z.string().optional(),
  modalApiKey: z.string().optional(),
  hfToken: z.string().optional(),
  dockerImage: z.string().optional(),
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Safely coerce a value to a finite number, returning defaultVal on failure. */
function toFiniteNumber(value: unknown, defaultVal: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return defaultVal;
}

/** Providers that map to a self-hosted GPU tier */
const GPU_OMNI_PROVIDERS = new Set(['skypilot', 'runpod', 'tensordock', 'vast', 'modal']);

interface TierCredentials {
  tensordockApiKey?: string;
  tensordockAuthId?: string;
  runpodApiKey?: string;
  vastApiKey?: string;
  modalApiKey?: string;
  hfToken?: string;
  dockerImage?: string;
  configGpuTypes?: string[];
}

/** Resolve the API key for a given provider from credentials */
function resolveApiKey(provider: GpuProvider, creds: TierCredentials): string | undefined {
  switch (provider) {
    case 'tensordock':
    case 'skypilot':
      return creds.tensordockApiKey;
    case 'runpod':
      return creds.runpodApiKey;
    case 'vast':
      return creds.vastApiKey;
    case 'modal':
      return creds.modalApiKey;
    default:
      return undefined;
  }
}

/** Build a GpuTierConfig from provider + instance data + credentials */
function buildTier(
  provider: GpuProvider,
  instanceData: { instanceId?: string; endpoint?: string; podId?: string; directUrl?: string },
  creds: TierCredentials,
): GpuTierConfig {
  const isTd = provider === 'tensordock' || provider === 'skypilot';
  return {
    provider,
    instanceId: instanceData.instanceId ?? instanceData.podId,
    endpoint: instanceData.directUrl ?? instanceData.endpoint,
    apiKey: resolveApiKey(provider, creds),
    ...(isTd && creds.tensordockAuthId ? { authId: creds.tensordockAuthId } : {}),
    ...(creds.configGpuTypes ? { gpuTypes: creds.configGpuTypes } : {}),
    ...(creds.hfToken ? { hfToken: creds.hfToken } : {}),
    ...(creds.dockerImage ? { dockerImage: creds.dockerImage } : {}),
  };
}

/**
 * Load and build the autoscaler config from user settings.
 * Uses the SettingsStore interface (not Prisma directly) for clean separation.
 */
export async function loadAutoscalerConfig(
  userId: string,
  settingsStore: SettingsStore,
  logger?: Logger,
): Promise<AutoScalerConfig | null> {
  const log = logger ?? defaultLogger;
  try {
    const ai = await settingsStore.get(userId) as Record<string, unknown>;

    // Validate autoscaler settings with Zod (fallback to raw if parse fails)
    const asCfgRaw = ai.autoscaler;
    const asCfgResult = AutoscalerSettingsSchema.safeParse(asCfgRaw);
    if (!asCfgResult.success) {
      // Zod parse failed — check if raw config has enabled flag
      const raw = asCfgRaw as Record<string, unknown> | undefined;
      if (!raw?.enabled) return null;
      log.warn('[autoscaler] Config validation failed, using raw values:', asCfgResult.error.issues.map(i => i.message).join(', '));
    }
    const asCfg = asCfgResult.success ? asCfgResult.data : (asCfgRaw as Record<string, unknown>);
    if (!asCfg?.enabled) {
      return null;
    }

    const threshold = toFiniteNumber(asCfg.threshold, 5);
    const windowMinutes = toFiniteNumber(asCfg.windowMinutes, 10);
    const maxLatencyMs = toFiniteNumber(asCfg.maxLatencyMs, 1500);

    // Validate skypilot credentials
    const skypilotRaw = ai.skypilot;
    const skypilotResult = SkypilotSchema.safeParse(skypilotRaw);
    const skypilot = skypilotResult.success ? skypilotResult.data : (skypilotRaw as Record<string, unknown> | undefined);

    const tensordockApiKey: string | undefined =
      (skypilot?.tensordockApiKey as string | undefined) ?? process.env.TENSORDOCK_API_TOKEN;
    const tensordockAuthId: string | undefined =
      (skypilot?.tensordockAuthId as string | undefined) ?? process.env.TENSORDOCK_AUTH_ID;
    const runpodApiKey: string | undefined =
      (skypilot?.runpodApiKey as string | undefined) ?? process.env.RUNPOD_API_KEY;
    const vastApiKey: string | undefined =
      (skypilot?.vastApiKey as string | undefined) ?? process.env.VAST_API_KEY;
    const modalApiKey: string | undefined =
      (skypilot?.modalApiKey as string | undefined) ?? (
        process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET
          ? `${process.env.MODAL_TOKEN_ID}:${process.env.MODAL_TOKEN_SECRET}`
          : process.env.MODAL_API_KEY
      );
    const hfToken: string | undefined =
      (skypilot?.hfToken as string | undefined) ?? process.env.HF_TOKEN;
    const dockerImage: string | undefined =
      (skypilot?.dockerImage as string | undefined) ?? process.env.PARLE_DOCKER_IMAGE;

    const creds: TierCredentials = {
      tensordockApiKey, tensordockAuthId, runpodApiKey, vastApiKey, modalApiKey, hfToken, dockerImage,
    };

    const rawGpuTypes = asCfg.gpuTypes;
    const configGpuTypes: string[] | undefined =
      Array.isArray(rawGpuTypes) && rawGpuTypes.length > 0
        ? rawGpuTypes as string[]
        : undefined;
    creds.configGpuTypes = configGpuTypes;

    let tiers: GpuTierConfig[] = [];

    const rawTiers = asCfg.tiers;
    if (Array.isArray(rawTiers) && rawTiers.length > 0) {
      tiers = (rawTiers as Array<Record<string, unknown>>).map((t) => {
        const provider = (t.provider as GpuProvider) ?? (asCfg.gpuProvider as GpuProvider);
        // Inject credentials from skypilot settings / env vars when not present in tier
        const isTd = provider === 'tensordock' || provider === 'skypilot';
        return {
          ...t,
          provider,
          gpuTypes: (t.gpuTypes as string[] | undefined) ?? configGpuTypes,
          apiKey: (t.apiKey as string | undefined) ?? resolveApiKey(provider, creds),
          ...(isTd && !t.authId && tensordockAuthId ? { authId: tensordockAuthId } : {}),
          ...(hfToken && !t.hfToken ? { hfToken } : {}),
          ...(dockerImage && !t.dockerImage ? { dockerImage } : {}),
        };
      });
    } else {
      const runpodPodKeys = ['runpodPod', 'runpodPod2'] as const;
      let runpodPodIdx = 0;
      const tensordockKeys = ['tensordockInstance', 'tensordockInstance2'] as const;
      let tensordockIdx = 0;
      const vastKeys = ['vastInstance', 'vastInstance2'] as const;
      let vastIdx = 0;

      const profiles: Array<{ pipelineMode?: string; provider?: string }> =
        (ai.profiles as Array<{ pipelineMode?: string; provider?: string }>) ?? [];

      for (const profile of profiles) {
        if (profile.pipelineMode !== 'omni') continue;
        if (!GPU_OMNI_PROVIDERS.has(profile.provider ?? '')) continue;

        if (profile.provider === 'skypilot' || profile.provider === 'tensordock') {
          const key = tensordockKeys[tensordockIdx] ?? tensordockKeys[tensordockKeys.length - 1];
          const instance = InstanceSchema.safeParse(ai[key]).data ?? {};
          tiers.push(buildTier('tensordock', {
            instanceId: instance.instanceId ?? (asCfg.gpuProvider as string | undefined),
            endpoint: instance.endpoint,
          }, creds));
          tensordockIdx++;
        } else if (profile.provider === 'runpod') {
          const key = runpodPodKeys[runpodPodIdx] ?? runpodPodKeys[runpodPodKeys.length - 1];
          const pod = InstanceSchema.safeParse(ai[key]).data ?? {};
          tiers.push(buildTier('runpod', {
            instanceId: pod.podId,
            endpoint: pod.directUrl ?? pod.endpoint,
          }, creds));
          runpodPodIdx++;
        } else if (profile.provider === 'vast') {
          const key = vastKeys[vastIdx] ?? vastKeys[vastKeys.length - 1];
          const instance = InstanceSchema.safeParse(ai[key]).data ?? {};
          tiers.push(buildTier('vast', {
            instanceId: instance.instanceId,
            endpoint: instance.directUrl ?? instance.endpoint,
          }, creds));
          vastIdx++;
        } else if (profile.provider === 'modal') {
          const modalInst = InstanceSchema.safeParse(ai.modalInstance).data ?? {};
          tiers.push(buildTier('modal', {
            instanceId: modalInst.instanceId,
            endpoint: modalInst.directUrl ?? modalInst.endpoint,
          }, { ...creds, configGpuTypes: creds.configGpuTypes ?? [] }));
        }

        if (tiers.length >= 10) break;
      }

      // Read dynamic instances (auto-provisioned tiers stored as array)
      const dynamicInstances = asCfg.dynamicInstances as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(dynamicInstances)) {
        for (const inst of dynamicInstances) {
          if (tiers.length >= 10) break;
          const provider = inst.provider as GpuProvider;
          if (provider === 'runpod' || provider === 'tensordock' || provider === 'vast' || provider === 'modal') {
            const parsed = InstanceSchema.safeParse(inst).data ?? {};
            tiers.push(buildTier(provider, {
              instanceId: parsed.instanceId ?? parsed.podId,
              endpoint: parsed.directUrl ?? parsed.endpoint,
            }, creds));
          }
        }
      }

      if (tiers.length === 0) {
        const tdInst = InstanceSchema.safeParse(ai.tensordockInstance).data;
        if (tdInst?.instanceId || tdInst?.endpoint) {
          tiers.push(buildTier('tensordock', tdInst, creds));
        }
        for (const key of ['runpodPod', 'runpodPod2'] as const) {
          const pod = InstanceSchema.safeParse(ai[key]).data;
          if (pod?.podId || pod?.endpoint) {
            tiers.push(buildTier('runpod', {
              instanceId: pod.podId,
              endpoint: pod.directUrl ?? pod.endpoint,
            }, creds));
          }
        }
        for (const key of ['vastInstance', 'vastInstance2'] as const) {
          const inst = InstanceSchema.safeParse(ai[key]).data;
          if (inst?.instanceId || inst?.endpoint) {
            tiers.push(buildTier('vast', {
              instanceId: inst.instanceId,
              endpoint: inst.directUrl ?? inst.endpoint,
            }, creds));
          }
        }
        // Modal fallback
        const modalInst = InstanceSchema.safeParse(ai.modalInstance).data;
        if (modalInst?.instanceId || modalInst?.endpoint) {
          tiers.push(buildTier('modal', {
            instanceId: modalInst.instanceId,
            endpoint: modalInst.directUrl ?? modalInst.endpoint,
          }, { ...creds, configGpuTypes: creds.configGpuTypes ?? [] }));
        }
      }
    }

    tiers = tiers.slice(0, 10);

    return {
      enabled: true,
      threshold,
      windowMinutes,
      maxLatencyMs,
      tiers,
      idleGraceMinutes: toFiniteNumber(asCfg.idleGraceMinutes, 15),
      ...(configGpuTypes ? { gpuTypes: configGpuTypes } : {}),
      // New feature configs
      ...(asCfg.loadBalanceStrategy ? { loadBalanceStrategy: asCfg.loadBalanceStrategy as string } : {}),
      ...(Array.isArray(asCfg.fallbackChains) ? { fallbackChains: asCfg.fallbackChains } : {}),
      ...(asCfg.predictiveWarmup ? { predictiveWarmup: asCfg.predictiveWarmup } : {}),
      // Backward-compat
      gpuProvider: tiers[0]?.provider,
      gpuInstanceId: tiers[0]?.instanceId,
      gpuEndpoint: tiers[0]?.endpoint,
      gpuApiKey: tiers[0]?.apiKey,
    } as AutoScalerConfig;
  } catch (err) {
    log.warn('[autoscaler] Failed to load config:', err);
    return null;
  }
}
