/**
 * Fireworks AI Image Provider — Flux text-to-image workflow.
 *
 * Uses the Fireworks workflow API which returns raw image bytes
 * (not the OpenAI-compatible images endpoint).
 */

import type { ProviderId, ImageProvider, ImageRequest, ImageResponse } from '../types';

const DEFAULT_MODEL = 'flux-1-dev-fp8';
const WORKFLOW_BASE = 'https://api.fireworks.ai/inference/v1/workflows/accounts/fireworks/models';
const ENV_KEY = 'FIREWORKS_API_KEY';

export class FireworksImageProvider implements ImageProvider {
  readonly providerId: ProviderId = 'fireworks';
  private apiKey: string | null = null;

  private getApiKey(): string {
    if (this.apiKey) return this.apiKey;
    const envKey = process.env[ENV_KEY];
    if (!envKey) throw new Error(`[Fireworks Image] ${ENV_KEY} is not set`);
    return envKey;
  }

  withApiKey(apiKey: string): FireworksImageProvider {
    const provider = new FireworksImageProvider();
    provider.apiKey = apiKey;
    return provider;
  }

  isConfigured(): boolean {
    return !!(this.apiKey || process.env[ENV_KEY]);
  }

  async generate(request: ImageRequest): Promise<ImageResponse> {
    const apiKey = this.getApiKey();
    const model = request.model || DEFAULT_MODEL;
    const url = `${WORKFLOW_BASE}/${model}/text_to_image`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: request.prompt,
        width: request.width ?? 1280,
        height: request.height ?? 720,
        num_inference_steps: request.steps ?? 25,
        seed: request.seed ?? Math.floor(Math.random() * 2147483647),
      }),
    });

    if (!response.ok) {
      const error = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`Fireworks Image API error ${response.status}: ${error.slice(0, 200)}`),
        { status: response.status },
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      image: Buffer.from(arrayBuffer),
      contentType: 'image/jpeg',
    };
  }
}

export const fireworksImage = new FireworksImageProvider();
