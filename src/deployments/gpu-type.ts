import type { DeploymentSpec } from './types';

export interface GpuTypeChoice { machineType: string; maxEurPerHour: number }

export function gpuTypeChoices(spec: DeploymentSpec): GpuTypeChoice[] {
  const first = spec.candidates?.[0];
  const standard = { machineType: first?.machineType ?? spec.machineType, maxEurPerHour: first?.maxEurPerHour ?? spec.maxEurPerHour };
  const others = Object.entries(spec.maxEurPerHourByMachineType ?? {})
    .filter(([type]) => type !== standard.machineType && spec.envByMachineType?.[type])
    .map(([machineType, maxEurPerHour]) => ({ machineType, maxEurPerHour }));
  return [standard, ...others];
}

export function withGpuType(spec: DeploymentSpec, machineType: string | undefined): DeploymentSpec {
  const choice = machineType ? gpuTypeChoices(spec).slice(1).find(c => c.machineType === machineType) : undefined;
  if (!choice) return spec;
  const rung = { provider: spec.candidates?.[0]?.provider ?? spec.provider, ...choice };
  return { ...spec, ...choice, ...(spec.candidates?.length ? { candidates: [rung] } : {}) };
}
