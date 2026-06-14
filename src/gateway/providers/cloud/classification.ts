/**
 * Single source of truth for provider classification.
 * Replaces ad-hoc sets scattered across get-user-provider.ts, gpu-autoscaler.ts,
 * and useTestPipelineMode.ts.
 */
export const ProviderClassification = {
  // All key-bearing cloud (non-GPU, non-local) providers. deepgram/elevenlabs/
  // minimax/modal/fal were previously omitted, which made buildFallbackChain
  // and the chain diversifier silently reject them (#312/#397) — e.g. the STT
  // diversifier's deepgram backup never got injected.
  cloud: new Set(['openai', 'groq', 'openrouter', 'fireworks', 'deepgram', 'elevenlabs', 'minimax', 'fal', 'zai']),
  selfHostedGpu: new Set(['skypilot', 'runpod', 'tensordock']),
  serverlessGpu: new Set(['modal', 'vast-serverless']),
  local: new Set(['ollama']),

  isCloud: (p: string): boolean => ProviderClassification.cloud.has(p),
  isSelfHostedGpu: (p: string): boolean => ProviderClassification.selfHostedGpu.has(p),
  isServerlessGpu: (p: string): boolean => ProviderClassification.serverlessGpu.has(p),
  isLocal: (p: string): boolean => ProviderClassification.local.has(p),
  isGpuBacked: (p: string): boolean =>
    ProviderClassification.isSelfHostedGpu(p) || ProviderClassification.isServerlessGpu(p),
} as const;
