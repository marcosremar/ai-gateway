// ── BabelCast Gateway — Avatar HTTP Handlers ─────────────────────────────────
// Proxies avatar commands to the avatar server running on the bot pod.
// The avatar server runs on port 3099 alongside the bot HTTP API on port 8080.

import type { IncomingMessage, ServerResponse } from 'http';
import { botState, deployState, isGpuAvailable } from './state';
import { client, translationProfile } from './providers';
import { readJsonBody, handleBodyError } from './http-utils';

/** Derive the avatar server URL from the bot pod endpoint.
 *  Bot endpoint: https://<podId>-8080.proxy.runpod.net or http://localhost:8085
 *  Avatar server: https://<podId>-3099.proxy.runpod.net or http://localhost:3099
 */
function getAvatarEndpoint(): string | null {
  const ep = botState.endpoint;
  if (!ep) return null;

  // RunPod proxy URL
  const runpodMatch = ep.match(/^(https?:\/\/)([^-]+)-8080(.*)$/);
  if (runpodMatch) {
    return `${runpodMatch[1]}${runpodMatch[2]}-3099${runpodMatch[3]}`;
  }

  // Local Docker: bot on 8085, avatar on 3099
  if (ep.includes('localhost:8085') || ep.includes('localhost:8080')) {
    return 'http://localhost:3099';
  }

  return null;
}

/** POST /v1/bot/avatar/speak — Generate TTS audio and send to avatar for lip-synced playback.
 *  Body: { text: string, voice?: string, lang?: string }
 *  OR:   { audio: base64, visemes?, vtimes?, vdurations? } (pre-generated audio)
 */
export async function handleAvatarSpeak(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const avatarUrl = getAvatarEndpoint();
  if (!avatarUrl) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No bot pod deployed or avatar endpoint not available' }));
    return;
  }

  try {
    let avatarPayload: Record<string, unknown>;

    if (typeof body.text === 'string' && body.text.trim() && !body.audio) {
      // Generate TTS audio from text, then send to avatar
      const text = (body.text as string).trim();
      const voice = (body.voice as string) || 'af_heart';
      const t0 = Date.now();

      console.log(`[avatar] Generating TTS for: "${text.slice(0, 60)}..." voice=${voice}`);

      const gpuEndpoint = isGpuAvailable() ? deployState.endpoint : null;
      let audioBuffer: Buffer;

      if (gpuEndpoint) {
        // Try GPU pod first
        const gpuRes = await fetch(`${gpuEndpoint}/v1/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, speaker: voice, language: 'English' }),
          signal: AbortSignal.timeout(15_000),
        });
        if (gpuRes.ok) {
          audioBuffer = Buffer.from(await gpuRes.arrayBuffer());
        } else {
          console.warn(`[avatar] GPU TTS failed (${gpuRes.status}), falling back to cloud`);
          const result = await client.synthesize(text, {
            ...translationProfile,
            gpuEndpoint: undefined,
            voice,
            audioFormat: 'wav',
          });
          audioBuffer = Buffer.isBuffer(result.audio) ? result.audio : Buffer.from(result.audio);
        }
      } else {
        // Cloud TTS (Modal Kokoro → Qwen3 → OpenAI fallback chain)
        const result = await client.synthesize(text, {
          ...translationProfile,
          gpuEndpoint: undefined,
          voice,
          audioFormat: 'wav',
        });
        audioBuffer = Buffer.isBuffer(result.audio) ? result.audio : Buffer.from(result.audio);
      }

      const latencyMs = Date.now() - t0;
      console.log(`[avatar] TTS generated: ${audioBuffer.length}B in ${latencyMs}ms`);

      // Send base64 audio + text to avatar for lip-synced playback
      avatarPayload = {
        audio: audioBuffer.toString('base64'),
        text, // avatar page uses this to generate word-level lip-sync
      };
    } else {
      // Pre-generated audio or other payload — pass through
      avatarPayload = body;
    }

    const apiRes = await fetch(`${avatarUrl}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(avatarPayload),
      signal: AbortSignal.timeout(30_000),
    });

    const result = await apiRes.json();
    res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[avatar] speak error:', err instanceof Error ? err.message : err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Avatar speak failed: ${(err as Error).message}` }));
  }
}

/** POST /v1/bot/avatar/animate-word — Real-time lip-sync without audio. */
export async function handleAvatarAnimateWord(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const avatarUrl = getAvatarEndpoint();
  if (!avatarUrl) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No bot pod deployed' }));
    return;
  }

  try {
    const apiRes = await fetch(`${avatarUrl}/api/animate-word`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });

    const result = await apiRes.json();
    res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Avatar animate-word failed: ${(err as Error).message}` }));
  }
}

/** POST /v1/bot/avatar/mood — Set avatar mood/expression. */
export async function handleAvatarMood(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const avatarUrl = getAvatarEndpoint();
  if (!avatarUrl) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No bot pod deployed' }));
    return;
  }

  try {
    const apiRes = await fetch(`${avatarUrl}/api/mood`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });

    const result = await apiRes.json();
    res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Avatar mood failed: ${(err as Error).message}` }));
  }
}

/** GET /v1/bot/avatar/status — Check if avatar is connected and ready. */
export async function handleAvatarStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const avatarUrl = getAvatarEndpoint();
  if (!avatarUrl) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ available: false, reason: 'No bot pod deployed' }));
    return;
  }

  try {
    const apiRes = await fetch(`${avatarUrl}/api/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    const status = await apiRes.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ available: true, avatarEndpoint: avatarUrl, ...status as object }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ available: false, reason: `Avatar server not reachable: ${(err as Error).message}` }));
  }
}
