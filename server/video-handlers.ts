// ── Video Generation Handler ─────────────────────────────────────────────────
// POST /v1/video/generate — proxy to wan-i2v GPU endpoint
//
// Body: { image_b64, preset?, num_frames?, fps?, height?, width?, num_inference_steps? }
// Response: { video_b64, num_frames, fps, duration_seconds, elapsed_ms }

import type { IncomingMessage, ServerResponse } from 'http';
import { deployState } from './state';
import { readJsonBody, handleBodyError } from './http-utils';

const GENERATE_TIMEOUT_MS = 600_000; // 10 min — large models can be slow

export async function handleVideoGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    handleBodyError(res, err);
    return;
  }

  if (!body.image_b64) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '`image_b64` is required' }));
    return;
  }

  const ep = deployState.status === 'ready' && deployState.endpoint ? deployState.endpoint : null;
  if (!ep) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GPU not ready', status: deployState.status }));
    return;
  }

  // Verify model is loaded before forwarding
  let modelLoaded = false;
  try {
    const healthRes = await fetch(`${ep}/health`, { signal: AbortSignal.timeout(10_000) });
    const health = await healthRes.json() as Record<string, unknown>;
    modelLoaded = health.model_loaded === true;
  } catch {
    // health check failed — try anyway
    modelLoaded = true;
  }

  if (!modelLoaded) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Model not loaded yet — wait for model_loaded=true' }));
    return;
  }

  try {
    const upstream = await fetch(`${ep}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });

    const result = await upstream.json();

    if (!upstream.ok) {
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `GPU request failed: ${msg}` }));
  }
}
