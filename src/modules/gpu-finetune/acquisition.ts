export const DEFAULT_VAST_SSH_BOOT_TIMEOUT_SEC = 600;

export interface VastSshAcquisitionPolicyInput {
  provider?: string;
  gpuFilter?: string;
  gpuName?: string;
  requestedBootTimeoutSec?: number;
  env?: Record<string, string | undefined>;
}

export interface VastSshAcquisitionPolicy {
  enabled: boolean;
  reason: string;
  bootTimeoutSec?: number;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function resolveVastSshAcquisitionPolicy(input: VastSshAcquisitionPolicyInput): VastSshAcquisitionPolicy {
  const env = input.env ?? process.env;
  const provider = String(input.provider ?? '').toLowerCase();
  const gpuText = `${input.gpuFilter ?? ''} ${input.gpuName ?? ''}`.toLowerCase();
  const enabled = provider === 'vast' && /\b5090\b/.test(gpuText);
  const envTimeoutSec = boundedInt(env.AIGW_VAST_SSH_BOOT_TIMEOUT_SEC, DEFAULT_VAST_SSH_BOOT_TIMEOUT_SEC, 30, 600);

  const bootTimeoutSec = input.requestedBootTimeoutSec != null
    ? boundedInt(input.requestedBootTimeoutSec, envTimeoutSec, 30, 600)
    : enabled ? envTimeoutSec : undefined;

  return {
    enabled,
    reason: enabled
      ? 'vast-5090-ssh-acquisition'
      : provider === 'vast' ? 'vast-non-5090' : 'provider-not-vast',
    ...(bootTimeoutSec ? { bootTimeoutSec } : {}),
  };
}
