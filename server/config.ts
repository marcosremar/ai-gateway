// ── BabelCast Gateway — Configuration ───────────────────────────────────────
// Env vars, GPU allowlists, image catalog, startup validation.

import { createLogger } from '../src/logger';
import {
  listImages as _listImages,
  getImageCatalogDynamic as _getImageCatalogDynamic,
} from './app-registry';

const log = createLogger('config');

export const PORT = parseInt(process.env.PORT || '4000');
export const PROVIDER = process.env.PROVIDER || 'groq';
export const RUNPOD_ENDPOINT = process.env.RUNPOD_ENDPOINT;  // e.g. http://pod-ip:8000
/** Full-pipeline server URL for tier 2 fallback (STT + LLM + TTS, same API as GPU pod).
 *  Set MODAL_BABELCAST_URL in .env to enable. No default — not activated unless configured. */
export const MODAL_BABELCAST_URL = process.env.MODAL_BABELCAST_URL;
/**
 * Provider chain — ordered fallback list parsed from PROVIDER_CHAIN env var.
 * Contains BOTH AI providers (groq, ollama) and GPU markers (gpu, runpod, vast).
 * Use AI_PROVIDERS / GPU_PROVIDER_IDS to filter by kind.
 */
export const PROVIDER_CHAIN: string[] = (process.env.PROVIDER_CHAIN || 'gpu,groq')
  .split(',').map(s => s.trim()).filter(Boolean);

/** GPU infrastructure provider IDs (deploy containers to these). */
export const GPU_PROVIDER_IDS = new Set(['runpod', 'tensordock', 'vast', 'modal', 'gpu']);

/** @deprecated Use GPU_PROVIDER_IDS */
export const GPU_PROVIDERS = GPU_PROVIDER_IDS;

/** AI cloud provider IDs (call APIs on these). */
export const AI_PROVIDER_IDS = new Set(['groq', 'openai', 'fireworks', 'openrouter', 'deepgram', 'elevenlabs', 'ollama']);

/** Balance threshold (USD) below which a low-balance alert is shown on the dashboard. */
export const LOW_BALANCE_THRESHOLD_USD = parseFloat(process.env.LOW_BALANCE_THRESHOLD_USD || '1');

// ── Docker Image Versioning ─────────────────────────────────────────────────

/** Docker image version — update when a new set of images is built and verified.
 *  CI/CD builds both :latest and :$DOCKER_IMAGE_VERSION tags.
 *  Pin deploys to a specific version for reproducibility; use :latest for dev. */
export const DOCKER_IMAGE_VERSION = process.env.DOCKER_IMAGE_VERSION || 'v1.3.0';

const IMAGE_PREFIX = process.env.DOCKER_IMAGE_PREFIX || 'marcosremar';

/** All known Docker image base names (without tag).
 *
 *  DEPRECATED STATIC FORM. The canonical source is now `server/app-registry.ts`,
 *  which reads from `$HOME/.ai-gateway/apps.json` (seeded on first boot) and
 *  optionally mirrors to `prisma.appRegistry`. Operators can add or remove
 *  entries at runtime via `POST/DELETE /v1/apps` without a code change.
 *
 *  Still exported as a getter for backward compatibility — anything that
 *  imported the old `as const` array now gets a dynamic array of the same
 *  shape. Callers that need the metadata (boot estimate, tags) should
 *  import `listImages()` from `./app-registry` instead. */
export function getDockerImageNames(): string[] {
  return _listImages().map(e => e.image);
}

/** @deprecated kept for call sites that pattern-match this name; reads from
 *  the dynamic registry under the hood. */
export const DOCKER_IMAGE_NAMES: readonly string[] = new Proxy([] as string[], {
  get(_t, prop) {
    const arr = getDockerImageNames();
    // Delegate every array-ish access to the fresh snapshot
    const v = (arr as any)[prop];
    return typeof v === 'function' ? v.bind(arr) : v;
  },
});

// ── GPU × Image compatibility ────────────────────────────────────────────────
// All images now use ARG BASE_IMAGE / CUDA_INDEX at build time.
// No runtime Blackwell image swap needed — each image is built for its target arch.
// resolveDockerImageForGpus is kept as a pass-through for backward compat.
// ─────────────────────────────────────────────────────────────────────────────

// Blackwell ↔ standard image maps (kept for gpu-deploy.ts backward compat)
export const STANDARD_TO_BLACKWELL: Record<string, string> = {
  [`${IMAGE_PREFIX}/babelcast-mistral:latest`]: `${IMAGE_PREFIX}/babelcast-blackwell-mistral:latest`,
  [`${IMAGE_PREFIX}/babelcast-mistral:${DOCKER_IMAGE_VERSION}`]: `${IMAGE_PREFIX}/babelcast-blackwell-mistral:${DOCKER_IMAGE_VERSION}`,
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
      log.log('Blackwell primary GPU (%s) — swapping image: %s → %s', primary, dockerImage, blackwellImage);
      return blackwellImage;
    }
  }
  return dockerImage;
}

/** Expose catalog via /v1/gpu/catalog endpoint for UI and debugging.
 *  Delegates to the dynamic registry so the catalog reflects runtime
 *  additions (via /v1/apps) without a redeploy. */
export function getImageCatalog() {
  return _getImageCatalogDynamic(DOCKER_IMAGE_VERSION);
}

/** Validate startup configuration. Exits process on fatal errors. */
export function validateStartupConfig() {
  if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
    log.error('Invalid PORT: %s. Must be 1-65535.', process.env.PORT);
    process.exit(1);
  }

  if (PROVIDER === 'ollama') {
    const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434/v1';
    try { new URL(ollamaHost); }
    catch { log.warn('OLLAMA_HOST "%s" is not a valid URL', ollamaHost); }
  }

  if (RUNPOD_ENDPOINT && !process.env.RUNPOD_API_KEY) {
    log.warn('RUNPOD_ENDPOINT set but RUNPOD_API_KEY is missing');
  }
}
