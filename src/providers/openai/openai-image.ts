/**
 * OpenAI Image Provider — DALL-E / GPT-Image text-to-image.
 *
 * Uses the OpenAI Images API which returns base64-encoded images.
 * POST https://api.openai.com/v1/images/generations
 */

import type { ProviderId, ImageProvider, ImageRequest, ImageResponse } from '../types';

const DEFAULT_MODEL = 'gpt-image-1';
const API_URL = 'https://api.openai.com/v1/images/generations';
const ENV_KEY = 'OPENAI_API_KEY';

/** Map width/height to the closest supported size string. */
function resolveSize(width?: number, height?: number): string {
  if (!width && !height) return '1024x1024';
  const w = width ?? 1024;
  const h = height ?? 1024;
  const ratio = w / h;
  // landscape
  if (ratio > 1.3) return '1792x1024';
  // portrait
  if (ratio < 0.77) return '1024x1792';
  return '1024x1024';
}

export class OpenAIImageProvider implements ImageProvider {
  readonly providerId: ProviderId = 'openai';
  private apiKey: string | null = null;

  private getApiKey(): string {
    if (this.apiKey) return this.apiKey;
    const envKey = process.env[ENV_KEY];
    if (!envKey) throw new Error(`[OpenAI Image] ${ENV_KEY} is not set`);
    return envKey;
  }

  withApiKey(apiKey: string): OpenAIImageProvider {
    const provider = new OpenAIImageProvider();
    provider.apiKey = apiKey;
    return provider;
  }

  isConfigured(): boolean {
    return !!(this.apiKey || process.env[ENV_KEY]);
  }

  async generate(request: ImageRequest): Promise<ImageResponse> {
    const apiKey = this.getApiKey();
    const model = request.model || DEFAULT_MODEL;
    const size = resolveSize(request.width, request.height);

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      n: 1,
      size,
    };

    // gpt-image-1 uses output_format (png/webp/jpeg); dall-e uses response_format (b64_json)
    if (model.startsWith('gpt-image')) {
      body.output_format = 'png';
    } else {
      body.response_format = 'b64_json';
    }

    // dall-e-3 supports quality param
    if (model.startsWith('dall-e')) {
      body.quality = 'standard';
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`OpenAI Image API error ${response.status}: ${error.slice(0, 200)}`),
        { status: response.status },
      );
    }

    const json = await response.json() as {
      data: Array<{ b64_json?: string; revised_prompt?: string }>;
    };

    const item = json.data?.[0];
    if (!item?.b64_json) {
      throw new Error('[OpenAI Image] No b64_json in response');
    }

    return {
      image: Buffer.from(item.b64_json, 'base64'),
      contentType: 'image/png',
      revisedPrompt: item.revised_prompt,
    };
  }
}

export const openaiImage = new OpenAIImageProvider();
