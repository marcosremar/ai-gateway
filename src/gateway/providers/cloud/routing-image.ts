/**
 * RoutingImageProvider — routes image generation requests to the right provider
 * based on the `model` field in the request.
 *
 * Model routing:
 *   'dit360'                 → Dit360ImageProvider (local GPU, native 360° panorama)
 *   'fal-ai/*'               → FalImageProvider (passthrough)
 *   'flux-schnell' / 'flux'  → FalImageProvider, mapped to 'fal-ai/flux/schnell'.
 *                              This is the alias the canal-dark / project-philosofi
 *                              pipeline uses (and the one a self-hosted flux pod
 *                              would expose); without the mapping fal.run would
 *                              get a literal `flux-schnell` model id and 404.
 *   'flux-pro' / 'flux-fill' → FalImageProvider, mapped to 'fal-ai/flux-pro/v1/fill'.
 *   'dall-e-3'               → OpenAIImageProvider (if configured) — currently
 *                              routed through fal as the in-house fallback
 *                              until an OpenAI image provider is wired up.
 *   default / unknown        → FalImageProvider with default model.
 *
 * Providers are instantiated lazily so missing API keys only fail on use.
 */

import type { ImageProvider, ImageRequest, ImageResponse } from './types';
import { FalImageProvider } from './fal/fal-image';
import { Dit360ImageProvider } from './dit360/dit360-image';

// Map short / vendor-neutral aliases the pipeline emits to the actual
// fal.run model paths. Without this, requests with `model: "flux-schnell"`
// hit `https://fal.run/flux-schnell` and fal returns 404 (which surfaces to
// the caller as a confusing 500 + provider_error). Keep this list close to
// the routing logic so additions don't drift.
const FAL_MODEL_ALIASES: Record<string, string> = {
  'flux-schnell': 'fal-ai/flux/schnell',
  flux: 'fal-ai/flux/schnell',
  'flux-pro': 'fal-ai/flux-pro/v1/fill',
  'flux-fill': 'fal-ai/flux-pro/v1/fill',
  'flux-dev': 'fal-ai/flux/dev',
};

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
    const model = (request.model ?? '').trim();

    // DiT360 — dedicated 360° panorama model
    if (model === 'dit360') {
      return this.dit360.generate(request);
    }

    // Bare aliases — map to fal.run paths so the upstream URL is valid.
    if (model && FAL_MODEL_ALIASES[model]) {
      return this.fal.generate({ ...request, model: FAL_MODEL_ALIASES[model] });
    }

    // Native fal-ai/... model paths — pass through verbatim
    if (model.startsWith('fal-ai/')) {
      return this.fal.generate(request);
    }

    // Empty model or unknown alias — drop it so FalImageProvider falls back
    // to its own default (fal-ai/flux/schnell) instead of forwarding the
    // bogus id to fal.run.
    if (!model) {
      return this.fal.generate({ ...request, model: undefined });
    }

    // Any other unrecognised model — surface a clear 400 instead of
    // silently sending it to fal where it'd 404.
    throw Object.assign(
      new Error(`Unknown image model "${model}". Known: dit360, flux-schnell, flux-pro, flux-dev, fal-ai/*`),
      { status: 400 },
    );
  }
}

export const routingImage = new RoutingImageProvider();
