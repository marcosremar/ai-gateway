import type { Admission, DeviceCapabilities, LocalDevice, LocalModels, LocalStage, StagePolicy } from './types';

export const LOCAL_STAGES: readonly LocalStage[] = ['tts', 'stt', 'llm'];
export const MOBILE_BUDGET_MB = 350;
export const DESKTOP_BUDGET_MB = 2048;

interface GpuAdapterLike {
  features: { has(feature: string): boolean };
  info?: { vendor?: string; architecture?: string };
}

export interface NavigatorLike {
  gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> };
  userAgent?: string;
  userAgentData?: { mobile?: boolean };
  maxTouchPoints?: number;
  deviceMemory?: number;
  storage?: { estimate(): Promise<{ quota?: number; usage?: number }> };
}

const isMobile = (nav: NavigatorLike) => {
  const ua = nav.userAgent ?? '';
  return nav.userAgentData?.mobile ?? (/Android|iPhone|iPad|Mobile/i.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1));
};

export async function probeDevice(nav: NavigatorLike = (globalThis as { navigator?: NavigatorLike }).navigator ?? {}): Promise<DeviceCapabilities> {
  const adapter = (await nav.gpu?.requestAdapter().catch(() => null)) ?? null;
  const estimate = (await nav.storage?.estimate().catch(() => null)) ?? null;
  return {
    webgpu: !!adapter,
    shaderF16: !!adapter?.features.has('shader-f16'),
    gpu: [adapter?.info?.vendor, adapter?.info?.architecture].filter(Boolean).join(' ') || null,
    mobile: isMobile(nav),
    deviceMemoryGb: nav.deviceMemory ?? null,
    storageFreeMb: estimate?.quota ? Math.round((estimate.quota - (estimate.usage ?? 0)) / 1e6) : null,
  };
}

export function defaultBudgetMb(caps: DeviceCapabilities): number {
  if (caps.mobile) return MOBILE_BUDGET_MB;
  return caps.deviceMemoryGb ? caps.deviceMemoryGb * 256 : DESKTOP_BUDGET_MB;
}

export function admitStages(
  policy: Partial<Record<LocalStage, StagePolicy>>,
  models: LocalModels,
  caps: DeviceCapabilities,
  budgetMb: number,
): Record<LocalStage, Admission> {
  let memoryLeft = budgetMb;
  let diskLeft = caps.storageFreeMb ?? Infinity;
  const admitOne = (stage: LocalStage): Admission => {
    if ((policy[stage] ?? 'gateway-only') === 'gateway-only') return { local: false, reason: 'policy' };
    const size = models[stage]?.size;
    if (!size) return { local: false, reason: 'no_model' };
    const devices = (caps.webgpu ? ['webgpu', 'wasm'] as const : ['wasm'] as const).filter(d => size[d]);
    if (!devices.length) return { local: false, reason: 'unsupported' };
    const device: LocalDevice | undefined = devices.find(d => size[d]!.memoryMb <= memoryLeft);
    if (!device) return { local: false, reason: 'over_budget' };
    const { memoryMb, downloadMb } = size[device]!;
    if (downloadMb > diskLeft) return { local: false, reason: 'storage' };
    memoryLeft -= memoryMb;
    diskLeft -= downloadMb;
    return { local: true, device, memoryMb, downloadMb };
  };
  const admitted = {} as Record<LocalStage, Admission>;
  for (const stage of LOCAL_STAGES) admitted[stage] = admitOne(stage);
  return admitted;
}
