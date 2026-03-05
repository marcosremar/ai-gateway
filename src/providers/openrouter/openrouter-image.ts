/**
 * OpenRouter Image Provider — image generation via chat completions with modalities.
 *
 * Uses models that support image output (e.g. Gemini) through the
 * OpenRouter chat/completions endpoint with `modalities: ["image", "text"]`.
 */

import type { ProviderId, ImageProvider, ImageRequest, ImageResponse } from '../types';

const DEFAULT_MODEL = 'google/gemini-2.5-flash-image';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ENV_KEY = 'OPENROUTER_API_KEY';

export class OpenRouterImageProvider implements ImageProvider {
  readonly providerId: ProviderId = 'openrouter';
  private apiKey: string | null = null;

  private getApiKey(): string {
    if (this.apiKey) return this.apiKey;
    const envKey = process.env[ENV_KEY];
    if (!envKey) throw new Error(`[OpenRouter Image] ${ENV_KEY} is not set`);
    return envKey;
  }

  withApiKey(apiKey: string): OpenRouterImageProvider {
    const provider = new OpenRouterImageProvider();
    provider.apiKey = apiKey;
    return provider;
  }

  isConfigured(): boolean {
    return !!(this.apiKey || process.env[ENV_KEY]);
  }

  async generate(request: ImageRequest): Promise<ImageResponse> {
    const apiKey = this.getApiKey();
    const model = request.model || DEFAULT_MODEL;

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://parle.app',
        'X-Title': 'PARLE',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: request.prompt }],
        modalities: ['image', 'text'],
      }),
    });

    if (!response.ok) {
      const error = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`OpenRouter Image API error ${response.status}: ${error.slice(0, 200)}`),
        { status: response.status },
      );
    }

    const json = await response.json() as {
      choices: Array<{
        message: {
          images?: Array<{ image_url: { url: string } }>;
          content?: string;
        };
      }>;
    };

    const images = json.choices?.[0]?.message?.images;
    if (!images?.length) {
      throw new Error('[OpenRouter Image] No images in response');
    }

    const dataUrl = images[0].image_url.url;
    // Parse data URL: "data:image/png;base64,..."
    const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error('[OpenRouter Image] Invalid data URL in response');
    }

    const contentType = match[1];
    const base64Data = match[2];

    return {
      image: Buffer.from(base64Data, 'base64'),
      contentType,
    };
  }
}

export const openrouterImage = new OpenRouterImageProvider();
