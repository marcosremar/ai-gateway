/**
 * RoutingImageProvider — routes image generation requests to the right provider
 * based on the `model` field in the request.
 *
 * Model routing:
 *   'dit360'         → Dit360ImageProvider (local GPU, native 360° panorama)
 *   'fal-ai/*'       → FalImageProvider
 *   'dall-e-3'       → OpenAIImageProvider (if configured)
 *   default          → FalImageProvider
 *
 * Providers are instantiated lazily so missing API keys only fail on use.
 */

import type { ImageProvider, ImageRequest, ImageResponse } from './types';
import { FalImageProvider } from './fal/fal-image';
import { Dit360ImageProvider } from './dit360/dit360-image';

export class RoutingImageProvider implements ImageProvider {
  readonly providerId = 'self-hosted' as const;

  private readonly fal: FalImageProvider;
  private readonly dit360: Dit360ImageProvider;

  constructor() {
    this.fal = new FalImageProvider();
    this.dit360 = new Dit360ImageProvider();
  }

  isConfigured(): boolean {
    return this.fal.isConfigured() || this.dit360.isConfigured();
  }

  async generate(request: ImageRequest): Promise<ImageResponse> {
    const model = request.model ?? '';

    // DiT360 — dedicated 360° panorama model
    if (model === 'dit360') {
      return this.dit360.generate(request);
    }

    // fal.ai models (FLUX, SDXL, etc.)
    if (model.startsWith('fal-ai/') || model === '' || !model) {
      return this.fal.generate(request);
    }

    // Unknown model — try fal as default
    return this.fal.generate(request);
  }
}

export const routingImage = new RoutingImageProvider();
