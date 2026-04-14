// ── Standby GPU State ────────────────────────────────────────────────────────
// State for standby (pre-provisioned) GPU pods used for seamless handover.
// Extracted from server/state.ts — Phase 5 DDD migration.

export interface StandbyDeployState {
  status: 'idle' | 'deploying' | 'benchmarking' | 'ready' | 'handover' | 'error';
  podId: string;
  endpoint: string;
  gpuType: string;
  dockerImage: string;
  provider: string;
  startedAt: number;
  triggeredReason: 'manual' | 'session_duration' | 'latency_degradation' | '';
  message: string;
  costPerHr: number;
  step: string;
}

export let standbyDeployState: StandbyDeployState = {
  status: 'idle', podId: '', endpoint: '', gpuType: '', dockerImage: '',
  provider: '', startedAt: 0, triggeredReason: '', message: '', costPerHr: 0, step: '',
};

export function setStandbyDeployState(patch: Partial<StandbyDeployState>): void {
  standbyDeployState = { ...standbyDeployState, ...patch };
}

export function resetStandbyDeployState(): void {
  standbyDeployState = {
    status: 'idle', podId: '', endpoint: '', gpuType: '', dockerImage: '',
    provider: '', startedAt: 0, triggeredReason: '', message: '', costPerHr: 0, step: '',
  };
}

/** When 'standby', setDeployState() writes to standbyDeployState instead of deployState. */
export let deployTarget: 'primary' | 'standby' = 'primary';
export function setDeployTarget(t: 'primary' | 'standby'): void { deployTarget = t; }

// Standby GPU health & routing state
export let standbyGpuHealthy = false;
export let standbyReadyForHandover = false;
export function setStandbyGpuHealthy(v: boolean): void { standbyGpuHealthy = v; }
export function setStandbyReadyForHandover(v: boolean): void { standbyReadyForHandover = v; }
