/**
 * RunPod Client Types
 */

import type { GpuInstance, GpuOffer } from '../types';

export interface RunpodCredentials {
  apiKey: string;
}

export interface RunpodNetworkVolume {
  id: string;
  name: string;
  size: number;
  dataCenterId: string;
}

export interface RunpodPod {
  id: string;
  name?: string;
  imageName: string;
  env: string[];
  gpuCount: number;
  volumeInGb: number;
  containerDiskInGb: number;
  minVcpuCount: number;
  minMemoryInGb: number;
  gpuTypeId: string;
  dataCenterId?: string;
  cloudType: 'COMMUNITY' | 'SECURE';
  supportPublicIp: boolean;
  deployCost?: number;
  runtime?: RunpodPodRuntime;
  desiredStatus: string;
  machineId?: string;
  machine?: {
    gpuDisplayName?: string;
  };
}

export interface RunpodPodRuntime {
  uptimeInSeconds?: number;
  ports?: RunpodPort[];
  gpus?: RunpodGpuInfo[];
  container?: {
    cpuPercent?: number;
    memoryPercent?: number;
    gpuMemoryPercent?: number;
  };
}

export interface RunpodPort {
  ip: string;
  privatePort: number;
  publicPort: number;
  type: string;
}

export interface RunpodGpuInfo {
  id: string;
  gpuUtilPercent?: number;
  memoryUtilPercent?: number;
  temperatureC?: number;
  powerDrawW?: number;
}

export interface RunpodOffer {
  id: string;
  gpuTypeId: string;
  gpuType: {
    id: string;
    displayName: string;
    memoryInGb: number;
  };
  dataCenterId: string;
  dataCenter: {
    id: string;
    name: string;
    location: string;
  };
  available: boolean;
  minVcpu: number;
  minMemory: number;
  minPodGpuCount: number;
  maxPodGpuCount: number;
  gpuAvailable: number;
  gpuUsed: number;
  gpuTotal: number;
  communityPrice: number;
  securePrice: number;
  secureSpotPrice: number;
  communitySpotPrice: number;
}

export interface CreatePodRequest {
  name?: string;
  imageName: string;
  dockerArgs?: string;
  ports?: string;
  volumeMountPath?: string;
  env: Record<string, string>;
  networkVolumeId?: string;
  gpuCount: number;
  volumeInGb: number;
  containerDiskInGb: number;
  minVcpuCount: number;
  minMemoryInGb: number;
  gpuTypeId: string;
  dataCenterId?: string;
  cloudType: 'COMMUNITY' | 'SECURE';
  supportPublicIp: boolean;
  startSsh?: boolean;
  start Jupyter?: boolean;
}

export interface RunpodInstance extends GpuInstance {
  podId: string;
  dataCenterId?: string;
  cloudType: 'COMMUNITY' | 'SECURE';
  runtime?: RunpodPodRuntime;
  ghostMachine?: boolean;
}

export interface RunpodInstanceDetail {
  id: string;
  status: string;
  imageName: string;
  gpuType: string;
  costPerHr: number;
  runtime?: RunpodPodRuntime;
  endpoint?: string;
  desiredStatus?: string;
  machineId?: string;
  dataCenterId?: string;
  ghostMachine?: boolean;
}

export type RunpodInstanceStatus = 
  | 'RUNNING'
  | 'CREATING'
  | 'EXITED'
  | 'ERROR'
  | 'STOPPED'
  | 'TERMINATED';

export interface RunpodApiResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}
