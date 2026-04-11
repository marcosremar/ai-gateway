/**
 * FAL AI Image Provider
 *
 * Supports two modes via the same `generate()` call:
 *
 *  1. Text-to-image   — prompt only          → FLUX.1 Schnell (fast, cheap)
 *  2. Inpainting      — prompt + imageUrl + maskUrl → FLUX.1 Fill Pro (mask-based)
 *
 * The inpainting mode is the primary use-case for 360° nadir floor patching:
 *   - imageUrl  = equirectangular 360 image
 *   - maskUrl   = white circle over the nadir (floor area), rest black
 *   - prompt    = "seamless stone/grass/wood floor matching the environment"
 *
 * FAL returns image URLs; we download the bytes and return them as Buffer
 * so the response is identical to other ImageProvider implementations.
 */

import type { ProviderId, ImageProvider, ImageRequest, ImageResponse } from '../types';

const ENV_KEY = 'FAL_KEY';

// FAL model endpoints
const MODELS = {
  /** Fast text-to-image — $0.003/step, good quality */
  textToImage: 'fal-ai/flux/schnell',
  /** Mask-based inpainting — FLUX.1 Fill Pro */
  inpaint: 'fal-ai/flux-pro/v1/fill',
} as const;

export const FAL_IMAGE_MODELS = [
  { id: MODELS.textToImage, name: 'FLUX.1 Schnell', description: 'Fast text-to-image generation', capability: 'image' as const },
  { id: MODELS.inpaint, name: 'FLUX.1 Fill Pro', description: 'Mask-based image inpainting', capability: 'image' as const },
];

interface FalResult {
  images?: Array<{ url: string; content_type?: string; width?: number; height?: number }>;
}

export class FalImageProvider implements ImageProvider {
  readonly providerId: ProviderId = 'fal';
  private apiKey: string | null = null;

  private getApiKey(): string {
    if (this.apiKey) return this.apiKey;
    const envKey = process.env[ENV_KEY];
    if (!envKey) throw new Error(`[FAL Image] ${ENV_KEY} is not set`);
    return envKey;
  }

  withApiKey(apiKey: string): FalImageProvider {
    const provider = new FalImageProvider();
    provider.apiKey = apiKey;
    return provider;
  }

  isConfigured(): boolean {
    return !!(this.apiKey || process.env[ENV_KEY]);
  }

  async generate(request: ImageRequest): Promise<ImageResponse> {
    const isInpaint = !!(request.imageUrl && request.maskUrl);
    return isInpaint ? this.inpaint(request) : this.textToImage(request);
  }

  // ── Text-to-image ──────────────────────────────────────────────────────────

  private async textToImage(request: ImageRequest): Promise<ImageResponse> {
    const apiKey = this.getApiKey();
    const model = request.model || MODELS.textToImage;
    const url = `https://fal.run/${model}`;

    const body = {
      prompt: request.prompt,
      image_size: this.resolveSize(request.width, request.height),
      num_inference_steps: request.steps ?? 4,
      seed: request.seed,
      num_images: request.n ?? 1,
      enable_safety_checker: false,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw Object.assign(
        new Error(`[FAL] Text-to-image error ${res.status}: ${err.slice(0, 300)}`),
        { status: res.status },
      );
    }

    const data = await res.json() as FalResult;
    return this.downloadFirstImage(data, 'image/jpeg');
  }

  // ── Inpainting ─────────────────────────────────────────────────────────────

  private async inpaint(request: ImageRequest): Promise<ImageResponse> {
    const apiKey = this.getApiKey();
    const url = `https://fal.run/${MODELS.inpaint}`;

    const body = {
      image_url: request.imageUrl,
      mask_url: request.maskUrl,
      prompt: request.prompt,
      num_inference_steps: request.steps ?? 28,
      seed: request.seed,
      num_images: request.n ?? 1,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw Object.assign(
        new Error(`[FAL] Inpaint error ${res.status}: ${err.slice(0, 300)}`),
        { status: res.status },
      );
    }

    const data = await res.json() as FalResult;
    return this.downloadFirstImage(data, 'image/jpeg');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private resolveSize(width?: number, height?: number): string {
    const w = width ?? 1024;
    const h = height ?? 1024;
    // FAL named presets
    if (w === 1024 && h === 1024) return 'square_hd';
    if (w === 1280 && h === 720)  return 'landscape_16_9';
    if (w === 720  && h === 1280) return 'portrait_16_9';
    if (w === 1024 && h === 576)  return 'landscape_4_3';
    // Fallback to explicit dimensions
    return JSON.stringify({ width: w, height: h }) as unknown as string;
  }

  private async downloadFirstImage(data: FalResult, fallbackType: string): Promise<ImageResponse> {
    const first = data.images?.[0];
    if (!first?.url) throw new Error('[FAL] No image in response');

    const imgRes = await fetch(first.url);
    if (!imgRes.ok) throw new Error(`[FAL] Failed to download result image: ${imgRes.status}`);

    const arrayBuffer = await imgRes.arrayBuffer();
    const contentType = first.content_type || fallbackType;

    return {
      image: Buffer.from(arrayBuffer),
      contentType,
    };
  }
}

export const falImage = new FalImageProvider();
