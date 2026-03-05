/**
 * Single source of truth for provider classification.
 * Replaces ad-hoc sets scattered across get-user-provider.ts, gpu-autoscaler.ts,
 * and useTestPipelineMode.ts.
 */
export const ProviderClassification = {
  cloud: new Set(['openai', 'groq', 'openrouter', 'fireworks']),
  selfHostedGpu: new Set(['skypilot', 'runpod', 'tensordock']),
  serverlessGpu: new Set(['modal', 'vast-serverless']),

  isCloud: (p: string): boolean => ProviderClassification.cloud.has(p),
  isSelfHostedGpu: (p: string): boolean => ProviderClassification.selfHostedGpu.has(p),
  isServerlessGpu: (p: string): boolean => ProviderClassification.serverlessGpu.has(p),
  isGpuBacked: (p: string): boolean =>
    ProviderClassification.isSelfHostedGpu(p) || ProviderClassification.isServerlessGpu(p),
} as const;
