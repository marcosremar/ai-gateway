// ── BabelCast Gateway — Configuration ───────────────────────────────────────
// Env vars, GPU allowlists, image catalog, startup validation.

export const PORT = parseInt(process.env.PORT || '4000');
export const PROVIDER = process.env.PROVIDER || 'groq';
export const RUNPOD_ENDPOINT = process.env.RUNPOD_ENDPOINT;  // e.g. http://pod-ip:8000
export const PROVIDER_CHAIN: string[] = (process.env.PROVIDER_CHAIN || 'gpu,groq')
  .split(',').map(s => s.trim()).filter(Boolean);
export const GPU_PROVIDERS = new Set(['runpod', 'tensordock', 'vast', 'modal', 'gpu']);

/** Balance threshold (USD) below which a low-balance alert is shown on the dashboard. */
export const LOW_BALANCE_THRESHOLD_USD = parseFloat(process.env.LOW_BALANCE_THRESHOLD_USD || '1');

// ── GPU × Image compatibility ────────────────────────────────────────────────
// All images now use ARG BASE_IMAGE / CUDA_INDEX at build time.
// No runtime Blackwell image swap needed — each image is built for its target arch.
// resolveDockerImageForGpus is kept as a pass-through for backward compat.
// ─────────────────────────────────────────────────────────────────────────────

// Blackwell ↔ standard image maps (kept for gpu-deploy.ts backward compat)
export const STANDARD_TO_BLACKWELL: Record<string, string> = {
  'marcosremar/babelcast-mistral:latest': 'marcosremar/babelcast-blackwell-mistral:latest',
};
export const BLACKWELL_TO_STANDARD: Record<string, string> = {};
for (const [std, bw] of Object.entries(STANDARD_TO_BLACKWELL)) {
  BLACKWELL_TO_STANDARD[bw] = std;
}

const BLACKWELL_GPU_NAMES = ['RTX 5090', 'RTX 5080', 'RTX 5070 Ti', 'RTX 5070', 'RTX 5060 Ti', 'RTX 5060'];

export function resolveDockerImageForGpus(dockerImage: string, gpuTypes: string[]): string {
  // Only swap image when the PRIMARY (first) GPU type is Blackwell.
  // Mixed lists like [RTX 5090, RTX 4090] keep the standard image so Ampere fallbacks work.
  // A Blackwell-only list like [RTX 5090] gets the Blackwell image.
  const primary = gpuTypes[0] ?? '';
  const isPrimaryBlackwell = BLACKWELL_GPU_NAMES.some(b => primary.includes(b));
  if (isPrimaryBlackwell) {
    const blackwellImage = STANDARD_TO_BLACKWELL[dockerImage];
    if (blackwellImage) {
      console.log(`[gpu] Blackwell primary GPU (${primary}) — swapping image: ${dockerImage} → ${blackwellImage}`);
      return blackwellImage;
    }
  }
  return dockerImage;
}

/** Expose catalog via /v1/gpu/catalog endpoint for UI and debugging. */
export function getImageCatalog() {
  return {
    images: [
      'marcosremar/babelcast-translategemma:latest',
      'marcosremar/babelcast-translategemma-only-subtitles:latest',
      'marcosremar/babelcast-mistral:latest',
      'marcosremar/babelcast-groq:latest',
      'marcosremar/babelcast-qwen3-tts:latest',
    ],
  };
}

/** Validate startup configuration. Exits process on fatal errors. */
export function validateStartupConfig() {
  if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`[gateway] Invalid PORT: ${process.env.PORT}. Must be 1-65535.`);
    process.exit(1);
  }

  if (PROVIDER === 'ollama') {
    const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434/v1';
    try { new URL(ollamaHost); }
    catch { console.warn(`[gateway] Warning: OLLAMA_HOST "${ollamaHost}" is not a valid URL`); }
  }

  if (RUNPOD_ENDPOINT && !process.env.RUNPOD_API_KEY) {
    console.warn('[gateway] Warning: RUNPOD_ENDPOINT set but RUNPOD_API_KEY is missing');
  }
}
