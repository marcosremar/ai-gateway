/**
 * POST /v1/images/generate  — text-to-image
 * POST /v1/images/inpaint   — mask-based inpainting (floor patching, 360° nadir, etc.)
 *
 * Both endpoints accept JSON and return raw image bytes with the appropriate
 * Content-Type header, identical to other ImageProvider implementations.
 *
 * Inpaint body:
 *   { prompt, imageUrl, maskUrl, width?, height?, steps?, seed? }
 *
 * Generate body:
 *   { prompt, model?, width?, height?, steps?, seed? }
 */

import { createHash } from 'crypto';
import type { ImageProvider } from '../../providers/cloud/types';
import type { ProxyRequest, ProxyResponse } from '../types';
import { withProxyRetry } from './retry';

interface GenerateBody {
  prompt?: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
}

interface InpaintBody extends GenerateBody {
  imageUrl?: string;
  maskUrl?: string;
}

// ── Image response cache (#329) ───────────────────────────────────────────
// Image generation is expensive and deterministic when seeded, so identical
// prompt+model+size+steps+seed requests re-bill the provider for byte-identical
// output. Cache by those fields with a long TTL. Only seeded (deterministic)
// requests are cached — an unseeded request is non-deterministic and caching it
// would pin one random image for the whole TTL.
const IMAGE_CACHE_TTL_MS = 60 * 60_000; // 1 hour
const IMAGE_CACHE_MAX_ENTRIES = 100;
const imageCache = new Map<string, { image: Buffer; contentType: string; expiresAt: number }>();

/** Build a deterministic image cache key from output-affecting params (#329). */
export function imageCacheKey(params: {
  prompt: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
}): string {
  return createHash('sha256')
    .update(
      `${params.model ?? '*'}\0${params.width ?? 0}\0${params.height ?? 0}\0` +
      `${params.steps ?? 0}\0${params.seed}\0${params.prompt}`,
    )
    .digest('hex')
    .slice(0, 24);
}

/** Whether an image request is deterministic enough to cache (#329). */
export function isImageCacheable(seed?: number): boolean {
  return typeof seed === 'number';
}

function imageCacheGet(key: string): { image: Buffer; contentType: string } | null {
  const entry = imageCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { imageCache.delete(key); return null; }
  // Refresh recency (insertion-ordered Map → re-insert as MRU).
  imageCache.delete(key);
  imageCache.set(key, entry);
  return { image: entry.image, contentType: entry.contentType };
}

function imageCacheSet(key: string, image: Buffer, contentType: string): void {
  while (imageCache.size >= IMAGE_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    let removedAny = false;
    for (const [k, v] of imageCache) {
      if (v.expiresAt < now) { imageCache.delete(k); removedAny = true; break; }
    }
    if (!removedAny) {
      const oldestKey = imageCache.keys().next().value;
      if (oldestKey !== undefined) imageCache.delete(oldestKey);
      else break;
    }
  }
  imageCache.set(key, { image, contentType, expiresAt: Date.now() + IMAGE_CACHE_TTL_MS });
}

/** Clear the image cache. Exported for tests. */
export function _resetImageCache(): void { imageCache.clear(); }

export async function handleImageGenerate(
  req: ProxyRequest,
  provider: ImageProvider | undefined,
): Promise<ProxyResponse> {
  if (!provider) {
    return { status: 501, body: { error: { message: 'No image provider configured', type: 'not_implemented' } } };
  }
  if (!provider.isConfigured()) {
    return { status: 503, body: { error: { message: 'Image provider is not configured (missing API key)', type: 'service_unavailable' } } };
  }

  if (!req.body || typeof req.body !== 'object') {
    return { status: 400, body: { error: { message: 'request body is required', type: 'invalid_request_error' } } };
  }
  const body = req.body as Record<string, unknown>;

  const prompt = typeof body.prompt === 'string' ? body.prompt : null;
  if (!prompt) {
    return { status: 400, body: { error: { message: '`prompt` is required', type: 'invalid_request_error' } } };
  }

  const genParams = {
    prompt,
    model: body.model as string | undefined,
    width: body.width as number | undefined,
    height: body.height as number | undefined,
    steps: body.steps as number | undefined,
    seed: body.seed as number | undefined,
  };

  // Cache check (#329) — only seeded (deterministic) requests are cacheable.
  const cacheable = isImageCacheable(genParams.seed);
  const cacheKey = cacheable ? imageCacheKey(genParams) : null;
  if (cacheKey) {
    const hit = imageCacheGet(cacheKey);
    if (hit) {
      return {
        status: 200,
        headers: { 'Content-Type': hit.contentType, 'X-Cache': 'HIT' },
        body: hit.image,
      };
    }
  }

  try {
    // Wrap with retry + cooldown (#376): a transient 5xx previously failed the
    // request outright since the image route called provider.generate directly.
    const result = await withProxyRetry(
      provider.providerId,
      genParams.model ?? 'default',
      () => provider.generate(genParams),
      'Image',
    );

    if (cacheKey) imageCacheSet(cacheKey, result.image, result.contentType);

    return {
      status: 200,
      headers: { 'Content-Type': result.contentType, ...(cacheable && { 'X-Cache': 'MISS' }) },
      body: result.image,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Preserve the provider's original 4xx/5xx so clients can fix bad requests
    // instead of always seeing a generic 500 (#314).
    const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status: number }).status : 500;
    return { status, body: { error: { message: msg, type: 'provider_error' } } };
  }
}

export async function handleImageInpaint(
  req: ProxyRequest,
  provider: ImageProvider | undefined,
): Promise<ProxyResponse> {
  if (!provider) {
    return { status: 501, body: { error: { message: 'No image provider configured', type: 'not_implemented' } } };
  }
  if (!provider.isConfigured()) {
    return { status: 503, body: { error: { message: 'Image provider is not configured (missing API key)', type: 'service_unavailable' } } };
  }

  if (!req.body || typeof req.body !== 'object') {
    return { status: 400, body: { error: { message: 'request body is required', type: 'invalid_request_error' } } };
  }
  const body = req.body as Record<string, unknown>;

  const prompt = typeof body.prompt === 'string' ? body.prompt : null;
  if (!prompt) {
    return { status: 400, body: { error: { message: '`prompt` is required', type: 'invalid_request_error' } } };
  }
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : null;
  const maskUrl = typeof body.maskUrl === 'string' ? body.maskUrl : null;
  if (!imageUrl || !maskUrl) {
    return { status: 400, body: { error: { message: '`imageUrl` and `maskUrl` are required for inpainting', type: 'invalid_request_error' } } };
  }
  // SSRF guard — both URLs are fetched server-side by the image provider.
  // Without this, a caller could exfiltrate cloud metadata (169.254.169.254),
  // probe internal services (10.*, 192.168.*), or hit localhost admin
  // endpoints. DNS-based check would be even safer; sync version blocks the
  // common literal-IP forms.
  const { isPrivateUrlResolved } = await import('../../pipeline/ssrf-protection');
  for (const [name, url] of [['imageUrl', imageUrl] as const, ['maskUrl', maskUrl] as const]) {
    if (await isPrivateUrlResolved(url)) {
      return {
        status: 400,
        body: { error: { message: `${name} resolves to a private/internal address (SSRF blocked)`, type: 'invalid_request_error' } },
      };
    }
  }

  try {
    const result = await provider.generate({
      prompt,
      model: body.model as string | undefined,
      width: body.width as number | undefined,
      height: body.height as number | undefined,
      steps: body.steps as number | undefined,
      seed: body.seed as number | undefined,
      imageUrl,
      maskUrl,
    });

    return {
      status: 200,
      headers: { 'Content-Type': result.contentType },
      body: result.image,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status: number }).status : 500;
    return { status, body: { error: { message: msg, type: 'provider_error' } } };
  }
}
