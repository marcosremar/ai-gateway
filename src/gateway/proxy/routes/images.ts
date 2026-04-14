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

import type { ImageProvider } from '../../providers/cloud/types';
import type { ProxyRequest, ProxyResponse } from '../types';

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

  try {
    const result = await provider.generate({
      prompt,
      model: body.model as string | undefined,
      width: body.width as number | undefined,
      height: body.height as number | undefined,
      steps: body.steps as number | undefined,
      seed: body.seed as number | undefined,
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
