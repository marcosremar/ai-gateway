/**
 * DiT360 Image Provider
 *
 * Wraps the local DiT360 service (FLUX.1-dev + DiT360 LoRA) which generates
 * native 2048×1024 equirectangular panoramic images from text prompts.
 *
 * Service repo: ~/projects/ai-gateway-dockers/dit360
 * Default port:  8000  (set DIT360_URL in env to override)
 *
 * Endpoint: POST /v1/images/generate
 * Response: { data: [{ b64_json: string }], model: "dit360", width, height, ... }
 */

import type { ImageProvider, ImageRequest, ImageResponse } from '../types';

const DEFAULT_URL = 'http://localhost:8000';
const ENV_URL = 'DIT360_URL';

interface Dit360Response {
  data?: Array<{ b64_json?: string; url?: string }>;
  model?: string;
  width?: number;
  height?: number;
  error?: string;
}

export class Dit360ImageProvider implements ImageProvider {
  readonly providerId = 'self-hosted' as const;
  private readonly serviceUrl: string;

  constructor(serviceUrl?: string) {
    this.serviceUrl = serviceUrl ?? process.env[ENV_URL] ?? DEFAULT_URL;
  }

  isConfigured(): boolean {
    // Always configured — just needs the local service running
    return true;
  }

  async generate(request: ImageRequest): Promise<ImageResponse> {
    const prompt = request.prompt?.trim();
    if (!prompt) throw new Error('[DiT360] prompt is required');

    const url = `${this.serviceUrl}/v1/images/generate`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        width: request.width ?? 2048,
        height: request.height ?? 1024,
        num_inference_steps: request.steps ?? 28,
        seed: request.seed ?? null,
        response_format: 'b64_json',
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw Object.assign(
        new Error(`[DiT360] Service error ${res.status}: ${err.slice(0, 300)}`),
        { status: res.status },
      );
    }

    const data = await res.json() as Dit360Response;

    if (data.error) {
      throw new Error(`[DiT360] ${data.error}`);
    }

    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('[DiT360] No image in response');

    return {
      image: Buffer.from(b64, 'base64'),
      contentType: 'image/png',
    };
  }
}

export const dit360Image = new Dit360ImageProvider();
