/**
 * Inference routes — AI pipeline endpoints
 *
 * Routes:
 *   GET  /v1/models                  — OpenAI-compatible model catalog
 *   POST /v1/transcribe              — Speech-to-text
 *   POST /v1/audio/align             — WhisperX word-level forced alignment
 *   POST /v1/transcribe/ensemble     — Ensemble transcription
 *   POST /v1/ensemble-transcribe     — Legacy ensemble transcription alias
 *   POST /v1/chat/completions        — LLM chat completions
 *   POST /v1/translate               — Translation
 *   POST /v1/tts/preview             — TTS preview
 *   POST /v1/audio/speech            — OpenAI-compat TTS (default voices, JSON body)
 *   POST /v1/audio/speech/clone      — Voice-clone TTS (multipart {text,reference_audio,ref_text})
 *                                      forwarded to the active qwen3-tts pod.
 *   POST /v1/speech                  — Full STT->LLM->TTS pipeline
 *   POST /v1/detect-language         — Language detection
 *   GET  /v1/analytics/system        — System analytics dashboard
 *   GET  /v1/auto-swap/status        — Auto-swap provider status
 *   POST /v1/auto-swap/toggle        — Toggle auto-swap
 *   POST /v1/auto-swap/benchmark     — Run auto-swap benchmark
 *   POST /v1/video/generate          — Video generation (wan-i2v GPU)
 *   POST /v1/diagrams/generate       — Manim CE animated diagrams (CPU pod)
 *   POST /v1/whiteboard/animate      — storyboard-ai OpenCV whiteboard render (CPU pod)
 *   GET  /v1/playground/catalog      — Playground model catalog
 *   POST /v1/playground/stt          — Playground STT
 *   POST /v1/playground/llm          — Playground LLM
 *   POST /v1/playground/tts          — Playground TTS
 *   POST /v1/playground/pipeline     — Playground full pipeline
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough } from 'stream';
import { createLogger } from '../../../src/logger';
import { readJsonBody, readRawBody } from '../../http-utils';
const log = createLogger('routes/inference');

type MultipartPart = { name?: string; filename?: string; data: Buffer };

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const match = contentType.match(/boundary=([^;]+)/i);
  const boundary = match?.[1]?.trim().replace(/^"|"$/g, '');
  if (!boundary || !/^[\w\-'()+,./:=? ]{1,70}$/.test(boundary)) {
    throw new Error('Invalid multipart boundary');
  }

  const parts: MultipartPart[] = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);
  if (body.indexOf(endBuf) === -1) {
    throw new Error('Malformed multipart body');
  }

  let start = body.indexOf(boundaryBuf);
  while (start !== -1 && parts.length < 20) {
    start += boundaryBuf.length;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    const next = body.indexOf(boundaryBuf, start);
    if (next === -1) break;

    const part = body.subarray(start, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const header = part.subarray(0, headerEnd).toString('utf8');
      let data = part.subarray(headerEnd + 4);
      if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
        data = data.subarray(0, data.length - 2);
      }
      parts.push({
        name: header.match(/name="([^"]{1,256})"/)?.[1],
        filename: header.match(/filename="([^"]{1,256})"/)?.[1],
        data: Buffer.from(data),
      });
    }

    if (body.indexOf(endBuf, next) === next) break;
    start = next;
  }
  return parts;
}

function makeBodyRequest(
  original: IncomingMessage,
  url: string,
  body: Buffer,
  contentType: string,
): IncomingMessage {
  const fakeReq = new PassThrough() as unknown as IncomingMessage & PassThrough;
  fakeReq.method = 'POST';
  fakeReq.url = url;
  fakeReq.headers = {
    ...original.headers,
    'content-type': contentType,
    'content-length': String(body.length),
  };
  queueMicrotask(() => fakeReq.end(body));
  return fakeReq;
}

async function handleAudioTranscriptionsCompat(
  req: IncomingMessage,
  res: ServerResponse,
  ai: { handleTranscribe: (req: IncomingMessage, res: ServerResponse) => Promise<void> },
): Promise<void> {
  const rawBody = await readRawBody(req, res);
  if (!rawBody) return;

  let audio = rawBody;
  const fields: Record<string, string> = {};
  const contentType = getHeader(req, 'content-type');

  if (/multipart\/form-data/i.test(contentType)) {
    try {
      for (const part of parseMultipart(rawBody, contentType)) {
        if (part.filename) audio = part.data;
        else if (part.name) fields[part.name] = part.data.toString('utf8');
      }
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : 'Invalid multipart body' });
      return;
    }
  }

  const params = new URLSearchParams();
  if (fields.language) params.set('language', fields.language);
  if (fields.prompt) params.set('prompt', fields.prompt);
  // VAD / endpointing knobs — passthrough to provider when supported
  // (currently honored by Deepgram). Gateway emits these as query params on
  // the internal /v1/transcribe handler which forwards to the provider.
  if (fields.endpointing_ms) params.set('endpointing_ms', fields.endpointing_ms);
  if (fields.vad_events) params.set('vad_events', fields.vad_events);
  if (fields.utterance_end_ms) params.set('utterance_end_ms', fields.utterance_end_ms);
  if (fields.interim_results) params.set('interim_results', fields.interim_results);
  if (fields.response_format) params.set('response_format', fields.response_format);
  const qs = params.toString();
  const fakeReq = makeBodyRequest(req, `/v1/transcribe${qs ? `?${qs}` : ''}`, audio, 'audio/wav');
  await ai.handleTranscribe(fakeReq, res);
}

async function handleAudioSpeechCompat(
  req: IncomingMessage,
  res: ServerResponse,
  ai: { handleTtsPreview: (req: IncomingMessage, res: ServerResponse) => Promise<void> },
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
    return;
  }
  const text = typeof body.input === 'string' ? body.input : body.text;
  const mapped = Buffer.from(JSON.stringify({
    text,
    speaker: body.voice ?? body.speaker ?? 'Ryan',
    language: body.language ?? 'English',
  }));
  const fakeReq = makeBodyRequest(req, '/v1/tts/preview', mapped, 'application/json');
  await ai.handleTtsPreview(fakeReq, res);
}

/**
 * POST /v1/audio/speech/clone — voice-cloned TTS via the qwen3-tts pod.
 *
 * Used by the canal-dark / project-philosofi pipeline to produce narration
 * in a target voice (e.g. Pursuit of Wonder reference clip) instead of the
 * default Modal speaker. The Qwen3-TTS Docker exposes a multipart endpoint
 * with the same path; this handler is a thin proxy that re-builds the
 * upstream request as native FormData (so fetch sets the boundary correctly)
 * and stream-pipes the response back.
 *
 * Body: multipart/form-data {
 *   text (form, required),
 *   reference_audio (file, required — 5-30s WAV/MP3/FLAC, any sample rate),
 *   ref_text (form, optional but strongly recommended — verbatim transcript
 *             of the reference clip; without it the model falls back to
 *             x-vector mode which loses prosody),
 *   response_format (form, optional — wav | mp3 | flac, default mp3),
 *   speed (form, optional — float, default 1.0)
 * }
 *
 * Upstream: QWEN3_TTS_URL env var, falling back to deployState.endpoint when
 * a qwen3-tts pod is currently warmed by ai-gateway (`/v1/gpu/deploy` with
 * `purpose: voice-clone`).
 */
async function handleAudioSpeechClone(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawBody = await readRawBody(req, res);
  if (!rawBody) return;

  const contentType = getHeader(req, 'content-type');
  if (!/multipart\/form-data/i.test(contentType)) {
    json(res, 400, { error: { message: 'multipart/form-data required', type: 'invalid_request_error' } });
    return;
  }

  // Re-parse so we can re-emit a clean multipart body with native FormData.
  // (Forwarding the raw bytes works too, but reusing parseMultipart bounds
  // the body and gives us better error messages on malformed uploads.)
  let referenceAudio: Buffer | null = null;
  let referenceFilename = 'reference.wav';
  let referenceContentType = 'application/octet-stream';
  const fields: Record<string, string> = {};
  try {
    for (const part of parseMultipart(rawBody, contentType)) {
      if (part.filename) {
        referenceAudio = part.data;
        referenceFilename = part.filename;
        if (/\.mp3$/i.test(part.filename)) referenceContentType = 'audio/mpeg';
        else if (/\.wav$/i.test(part.filename)) referenceContentType = 'audio/wav';
        else if (/\.m4a$/i.test(part.filename)) referenceContentType = 'audio/mp4';
        else if (/\.flac$/i.test(part.filename)) referenceContentType = 'audio/flac';
        else if (/\.ogg$/i.test(part.filename)) referenceContentType = 'audio/ogg';
      } else if (part.name) {
        fields[part.name] = part.data.toString('utf8');
      }
    }
  } catch (err) {
    json(res, 400, { error: { message: err instanceof Error ? err.message : 'Invalid multipart body', type: 'invalid_request_error' } });
    return;
  }

  if (!referenceAudio || referenceAudio.length === 0) {
    json(res, 400, { error: { message: '`reference_audio` file is required', type: 'invalid_request_error' } });
    return;
  }
  if (!fields.text || !fields.text.trim()) {
    json(res, 400, { error: { message: '`text` form field is required', type: 'invalid_request_error' } });
    return;
  }

  let target = process.env.QWEN3_TTS_URL || '';
  if (!target) {
    try {
      const { deployState } = require('../../state');
      if (deployState?.status === 'ready' && deployState?.endpoint) {
        target = deployState.endpoint;
      }
    } catch { /* state optional */ }
  }
  if (!target) {
    json(res, 503, { error: { message: 'no qwen3-tts upstream — set QWEN3_TTS_URL or deploy a voice-clone pod via /v1/gpu/deploy', type: 'service_unavailable' } });
    return;
  }

  const url = `${target.replace(/\/+$/, '')}/v1/audio/speech/clone`;

  const form = new FormData();
  form.append(
    'reference_audio',
    new Blob([new Uint8Array(referenceAudio)], { type: referenceContentType }),
    referenceFilename,
  );
  form.append('text', fields.text);
  if (fields.ref_text) form.append('ref_text', fields.ref_text);
  if (fields.response_format) form.append('response_format', fields.response_format);
  if (fields.speed) form.append('speed', fields.speed);

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(600_000), // 10 min — clone takes 20-40s typical, extra slack for cold pods
    });
    const respCt = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { 'Content-Type': respCt });
    res.end(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[/v1/audio/speech/clone] upstream failed: ${msg.slice(0, 200)}`);
    json(res, 502, { error: { message: `qwen3-tts upstream unreachable: ${msg}`, type: 'bad_gateway' } });
  }
}

async function handleTtsVoices(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { getAllVoiceCatalogs } = await import('../../../src/providers/voice-catalog');
  const voices = getAllVoiceCatalogs().flatMap((catalog) =>
    catalog.models.flatMap((model) =>
      model.voices.map((voice) => ({
        ...voice,
        provider: catalog.providerId,
        providerName: catalog.providerName,
        model: model.id,
        modelName: model.name,
        // Ready-to-use routing string for /v1/tts/preview's `speaker` field.
        // The preview pipeline parses `engine/voice` and dispatches to the
        // matching backend so Kokoro voices don't get swallowed by Qwen3.
        speaker: `${catalog.providerId}/${voice.id}`,
      })),
    ),
  );
  json(res, 200, { voices, catalogs: getAllVoiceCatalogs() });
}

async function handleDiagramGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
    return;
  }

  if (typeof body.scene_class !== 'string' || typeof body.scene_code !== 'string') {
    json(res, 400, { error: { message: '`scene_class` and `scene_code` are required', type: 'invalid_request_error' } });
    return;
  }

  const target = process.env.MANIM_URL || 'http://localhost:8000';
  const url = `${target.replace(/\/+$/, '')}/v1/diagrams/generate`;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { 'Content-Type': contentType });
    res.end(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[/v1/diagrams/generate] upstream failed: ${msg.slice(0, 200)}`);
    json(res, 502, { error: { message: `manim upstream unreachable: ${msg}`, type: 'bad_gateway' } });
  }
}

/**
 * POST /v1/audio/align — forward multipart audio to the whisper-align pod
 * for word-level forced alignment. Used by the canal-dark / project-philosofi
 * pipeline to convert narration audio → timing.json so Remotion can sync
 * scene cuts to spoken sentences.
 *
 * Body: multipart/form-data { audio (file), text? (form), language? (form) }.
 * Upstream: WHISPER_ALIGN_URL env var (defaults to the active GPU pod's
 * endpoint when ready, otherwise http://localhost:8000).
 */
async function handleAudioAlign(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawBody = await readRawBody(req, res);
  if (!rawBody) return;

  const contentType = getHeader(req, 'content-type');
  if (!/multipart\/form-data/i.test(contentType)) {
    json(res, 400, { error: { message: 'multipart/form-data required', type: 'invalid_request_error' } });
    return;
  }

  let audio: Buffer | null = null;
  let audioFilename = 'audio.wav';
  let audioContentType = 'application/octet-stream';
  const fields: Record<string, string> = {};
  try {
    for (const part of parseMultipart(rawBody, contentType)) {
      if (part.filename) {
        audio = part.data;
        audioFilename = part.filename;
        if (/\.mp3$/i.test(part.filename)) audioContentType = 'audio/mpeg';
        else if (/\.wav$/i.test(part.filename)) audioContentType = 'audio/wav';
        else if (/\.m4a$/i.test(part.filename)) audioContentType = 'audio/mp4';
        else if (/\.flac$/i.test(part.filename)) audioContentType = 'audio/flac';
        else if (/\.ogg$/i.test(part.filename)) audioContentType = 'audio/ogg';
      } else if (part.name) {
        fields[part.name] = part.data.toString('utf8');
      }
    }
  } catch (err) {
    json(res, 400, { error: { message: err instanceof Error ? err.message : 'Invalid multipart body', type: 'invalid_request_error' } });
    return;
  }

  if (!audio || audio.length === 0) {
    json(res, 400, { error: { message: '`audio` file is required', type: 'invalid_request_error' } });
    return;
  }

  let target = process.env.WHISPER_ALIGN_URL || '';
  let targetSource: 'env' | 'deployState' | 'default' = 'env';
  if (!target) {
    try {
      const { deployState } = require('../../state');
      if (deployState?.status === 'ready' && deployState?.endpoint) {
        target = deployState.endpoint;
        targetSource = 'deployState';
      }
    } catch {/* state optional */}
  }
  if (!target) {
    // No pod warmed and no env override — surface a clear 503 instead of
    // a confusing 404 from a non-existent localhost listener. Caller
    // (canal-dark pipeline `align_audio_whisper`) catches the failure and
    // falls back to script `duration_s`, but the operator deserves a hint.
    json(res, 503, {
      error: {
        message:
          'whisper-align pod not deployed. Set WHISPER_ALIGN_URL or deploy via /v1/gpu/deploy {purpose:"alignment"}',
        type: 'service_unavailable',
        deploy_cmd:
          'curl -X POST http://localhost:4000/v1/gpu/deploy -H "Content-Type: application/json" -d \'{"purpose":"alignment","model":"whisper-align"}\'',
      },
    });
    return;
  }

  const url = `${target.replace(/\/+$/, '')}/v1/audio/align`;

  // Re-build multipart body for upstream — use Web FormData/Blob, fetch
  // will set the correct content-type/boundary header automatically.
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(audio)], { type: audioContentType }), audioFilename);
  if (fields.text) form.append('text', fields.text);
  if (fields.language) form.append('language', fields.language);

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(900_000), // 15 min — long narrations
    });
    const respCt = upstream.headers.get('content-type') ?? 'application/json';
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (upstream.status === 404) {
      // Upstream pod is up but doesn't expose /v1/audio/align — surface a
      // clearer message so callers know it's an upstream config issue, not
      // a missing gateway route.
      json(res, 503, {
        error: {
          message: `whisper-align upstream (${targetSource}=${target}) returned 404 — pod likely not running the align service`,
          type: 'service_unavailable',
        },
      });
      return;
    }
    res.writeHead(upstream.status, { 'Content-Type': respCt });
    res.end(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[/v1/audio/align] upstream failed: ${msg.slice(0, 200)}`);
    json(res, 502, { error: { message: `whisper-align upstream unreachable: ${msg}`, type: 'bad_gateway' } });
  }
}

/**
 * POST /v1/whiteboard/animate — forward multipart payload to the
 * storyboard-whiteboard pod (OpenCV hand-drawn animation engine, GPL-3.0).
 *
 * Used by canal-dark / project-philosofi pipeline Pattern 9 (Whiteboard) to
 * turn a FLUX-generated line-drawing PNG (+ optional LabelMe JSON mask) into
 * an MP4 of a hand drawing the image cell-by-cell on a whiteboard. Replaces
 * the previous SVG-turbulence WhiteboardDraw.tsx hack.
 *
 * Body: multipart/form-data {
 *   image (file PNG, required),
 *   mask  (file JSON, optional),
 *   hand  (file PNG, optional — uses bundled sprite when absent),
 *   hand_mask (file PNG, optional),
 *   frame_rate, resize, split_len, object_skip_rate, bg_object_skip_rate,
 *   end_duration_s, response_format
 * }.
 * Upstream: STORYBOARD_WHITEBOARD_URL env var (defaults http://localhost:8000).
 */
async function handleWhiteboardAnimate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawBody = await readRawBody(req, res);
  if (!rawBody) return;

  const contentType = getHeader(req, 'content-type');
  if (!/multipart\/form-data/i.test(contentType)) {
    json(res, 400, { error: { message: 'multipart/form-data required', type: 'invalid_request_error' } });
    return;
  }

  // Re-parse + re-build so we can normalise field types and bound the body.
  const parts: Record<string, MultipartPart> = {};
  try {
    for (const part of parseMultipart(rawBody, contentType)) {
      if (!part.name) continue;
      parts[part.name] = part;
    }
  } catch (err) {
    json(res, 400, { error: { message: err instanceof Error ? err.message : 'Invalid multipart body', type: 'invalid_request_error' } });
    return;
  }

  const image = parts.image;
  if (!image || !image.filename || image.data.length === 0) {
    json(res, 400, { error: { message: '`image` file is required', type: 'invalid_request_error' } });
    return;
  }

  let target = process.env.STORYBOARD_WHITEBOARD_URL || '';
  if (!target) {
    try {
      const { deployState } = require('../../state');
      if (deployState?.status === 'ready' && deployState?.endpoint) {
        target = deployState.endpoint;
      }
    } catch {/* state optional */}
  }
  if (!target) target = 'http://localhost:8000';

  const url = `${target.replace(/\/+$/, '')}/v1/whiteboard/animate`;

  const form = new FormData();
  form.append(
    'image',
    new Blob([new Uint8Array(image.data)], { type: 'image/png' }),
    image.filename,
  );

  const fileFields: Array<[string, string]> = [
    ['mask', 'application/json'],
    ['hand', 'image/png'],
    ['hand_mask', 'image/png'],
  ];
  for (const [name, mime] of fileFields) {
    const p = parts[name];
    if (p && p.filename && p.data.length > 0) {
      form.append(name, new Blob([new Uint8Array(p.data)], { type: mime }), p.filename);
    }
  }

  const textFields = [
    'frame_rate', 'resize', 'split_len',
    'object_skip_rate', 'bg_object_skip_rate', 'end_duration_s',
    'response_format',
  ];
  for (const name of textFields) {
    const p = parts[name];
    if (p && !p.filename) {
      form.append(name, p.data.toString('utf8'));
    }
  }

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(600_000), // 10 min — even 4K rarely > 60s
    });
    const respCt = upstream.headers.get('content-type') ?? 'application/json';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { 'Content-Type': respCt });
    res.end(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[/v1/whiteboard/animate] upstream failed: ${msg.slice(0, 200)}`);
    json(res, 502, { error: { message: `storyboard-whiteboard upstream unreachable: ${msg}`, type: 'bad_gateway' } });
  }
}

async function handleImageGenerateCompat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
    return;
  }

  // Parse OpenAI-style "1024x1024" size into {width, height} so the underlying
  // provider gets explicit dims (FAL accepts named presets, but other providers
  // need integers). Untouched if size is missing or already split.
  if (typeof body.size === 'string' && body.width === undefined) {
    const m = /^\s*(\d+)\s*[xX]\s*(\d+)\s*$/.exec(body.size);
    if (m) {
      body.width = Number(m[1]);
      body.height = Number(m[2]);
    }
  }

  // Direct-Modal short-circuit. When MODAL_IMAGE_URL is set, forward the
  // request straight to that OpenAI-compatible endpoint instead of going
  // through the in-process routing-image cascade. Lets canal-dark hit a
  // pay-per-use Qwen-Image / FLUX deployment without paying L40S idle.
  // Same pattern as QWEN3_TTS_URL on the clone path.
  const modalImageUrl = process.env.MODAL_IMAGE_URL;
  if (modalImageUrl) {
    try {
      const upstream = await fetch(`${modalImageUrl.replace(/\/+$/, '')}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      });
      res.end(buf);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[/v1/images/generations] MODAL_IMAGE_URL upstream failed: ${msg.slice(0, 200)}`);
      json(res, 502, { error: { message: `MODAL_IMAGE_URL upstream unreachable: ${msg}`, type: 'bad_gateway' } });
      return;
    }
  }

  const { handleImageGenerate } = await import('../../../src/proxy/routes/images');
  const { routingImage } = await import('../../../src/providers/routing-image');
  const proxyRes = await handleImageGenerate({
    method: 'POST',
    url: '/v1/images/generate',
    headers: req.headers as Record<string, string>,
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
  }, routingImage);

  const headers = proxyRes.headers ?? {};
  // OpenAI-compat callers (canal-dark / project-philosofi pipeline) request
  // `response_format: "b64_json"` and expect `{ data: [{ b64_json }], … }`.
  // The underlying provider returns raw image bytes, so we re-wrap here when
  // the request is JSON-shaped. Also handle the legacy `url` format.
  if (proxyRes.status === 200 && (Buffer.isBuffer(proxyRes.body) || proxyRes.body instanceof Uint8Array)) {
    const rf = typeof body.response_format === 'string' ? body.response_format : '';
    if (rf === 'b64_json' || rf === 'url') {
      const buf = Buffer.isBuffer(proxyRes.body) ? proxyRes.body : Buffer.from(proxyRes.body);
      const ct = (headers as Record<string, string>)['Content-Type'] || 'image/png';
      const payload =
        rf === 'b64_json'
          ? { created: Math.floor(Date.now() / 1000), data: [{ b64_json: buf.toString('base64') }] }
          : { created: Math.floor(Date.now() / 1000), data: [{ url: `data:${ct};base64,${buf.toString('base64')}` }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(proxyRes.status, headers);
    res.end(proxyRes.body);
    return;
  }
  res.writeHead(proxyRes.status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(proxyRes.body));
}

/**
 * POST /v1/3d/generate — image-to-3D via TRELLIS.2 on Modal.
 *
 * Body: multipart/form-data {image (file), resolution=512|1024|1536, format=glb|ply}
 * Upstream: MODAL_TRELLIS2_URL (no fallback — TRELLIS.2 has no
 * gateway-managed pod equivalent yet).
 */
async function handleTrellis2Generate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const target = process.env.MODAL_TRELLIS2_URL;
  if (!target) {
    json(res, 503, {
      error: { message: 'TRELLIS.2 upstream not configured — set MODAL_TRELLIS2_URL', type: 'service_unavailable' },
    });
    return;
  }
  const rawBody = await readRawBody(req, res);
  if (!rawBody) return;
  try {
    const upstream = await fetch(`${target.replace(/\/+$/, '')}/v1/3d/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': getHeader(req, 'content-type'),
      },
      body: new Uint8Array(rawBody),
      signal: AbortSignal.timeout(900_000),  // 1024³ takes ~30s on A100
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get('content-type') ?? 'application/octet-stream';
    res.writeHead(upstream.status, { 'Content-Type': ct });
    res.end(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[/v1/3d/generate] upstream failed: ${msg.slice(0, 200)}`);
    json(res, 502, { error: { message: `TRELLIS.2 upstream unreachable: ${msg}`, type: 'bad_gateway' } });
  }
}

/**
 * GET /v1/models — OpenAI-compatible model list derived from active app's pipeline chain.
 */
function modelCapabilities(capability: string, provider?: string, model?: string): string[] {
  const caps = new Set<string>([capability]);
  const id = `${provider || ''}/${model || ''}`.toLowerCase();
  if (capability === 'llm') caps.add('chat');
  if (capability === 'stt') caps.add('audio-in');
  if (capability === 'tts') caps.add('audio-out');
  if (/vision|vl|gemini|gpt-4o|claude|llava|qwen2\.5-vl|qwen3-vl/.test(id)) caps.add('vision');
  if (provider === 'openrouter' && model) caps.add('provider-shortcut');
  return Array.from(caps);
}

async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const models = new Map<string, { id: string; object: 'model'; created: number; owned_by: string; capability: string; capabilities: string[]; shortcut?: string }>();

  try {
    const cfg = require('../../config-persistence');
    const app = await cfg.getActiveApp?.();
    const add = (capability: string, providers: Array<{ provider?: string; model?: string }> | undefined) => {
      if (!Array.isArray(providers)) return;
      for (const p of providers) {
        const id = p?.model;
        if (!id || models.has(id)) continue;
        models.set(id, {
          id,
          object: 'model',
          created: now,
          owned_by: p.provider || 'ai-gateway',
          capability,
          capabilities: modelCapabilities(capability, p.provider, id),
          ...(p.provider === 'openrouter' ? { shortcut: `openrouter/${id}` } : {}),
        });
      }
    };
    if (app) {
      add('stt', app.stt);
      add('llm', app.llm);
      add('tts', app.tts);
    }
  } catch (e: any) {
    log.warn(`[/v1/models] config read failed: ${e?.message?.slice(0, 80)}`);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: Array.from(models.values()) }));
}

export function registerInferenceRoutes(handlers: Record<string, Function>): void {
  // OpenAI-compatible model catalog
  handlers['GET /v1/models'] = handleModels;

  // AI handlers (inference endpoints) + Auto-swap
  try {
    const ai = require('../../ai-handlers');
    Object.assign(handlers, {
      // Inference
      'POST /v1/transcribe': ai.handleTranscribe,
      'POST /v1/transcribe/ensemble': ai.handleEnsembleTranscribe,
      'POST /v1/ensemble-transcribe': ai.handleEnsembleTranscribe,
      'POST /v1/audio/transcriptions': (req: IncomingMessage, res: ServerResponse) => handleAudioTranscriptionsCompat(req, res, ai),
      'POST /v1/chat/completions': ai.handleChatCompletions,
      'POST /v1/embeddings': ai.handleEmbeddings,
      'POST /v1/translate': ai.handleTranslate,
      'POST /v1/tts': ai.handleTtsPreview,
      'POST /v1/tts-preview': ai.handleTtsPreview,
      'POST /v1/tts/preview': ai.handleTtsPreview,
      'GET /v1/tts/voices': handleTtsVoices,
      'POST /v1/audio/speech': (req: IncomingMessage, res: ServerResponse) => handleAudioSpeechCompat(req, res, ai),
      // Voice-clone TTS (multipart) — proxied to qwen3-tts pod (env QWEN3_TTS_URL or active deployState)
      'POST /v1/audio/speech/clone': handleAudioSpeechClone,
      'POST /v1/images/generate': handleImageGenerateCompat,
      // OpenAI-compatible plural (canal-dark / project-philosofi pipeline + flux Docker)
      'POST /v1/images/generations': handleImageGenerateCompat,
      // Manim CE diagram render (Pattern 4 Blueprint Stoic, Pattern 9 Whiteboard)
      'POST /v1/diagrams/generate': handleDiagramGenerate,
      // TRELLIS.2 image-to-3D (MIT, Microsoft) — multipart {image, resolution,
      // format} → mesh binary. Proxied to MODAL_TRELLIS2_URL when set.
      'POST /v1/3d/generate': handleTrellis2Generate,
      // WhisperX word-level forced alignment (canal-dark / project-philosofi
      // narration → timing.json so Remotion can snap scenes to sentence boundaries)
      'POST /v1/audio/align': handleAudioAlign,
      // storyboard-ai OpenCV whiteboard hand-drawn render (Pattern 9 — replaces
      // the SVG-turbulence WhiteboardDraw.tsx hack with object-by-object draw)
      'POST /v1/whiteboard/animate': handleWhiteboardAnimate,
      'POST /v1/speech': ai.handlePipeline,
      'POST /v1/detect-language': ai.handleDetectLanguage,
      'GET /v1/analytics/system': ai.handleSystemAnalytics,
      // Auto-swap
      'GET /v1/auto-swap/status': ai.handleAutoSwapStatus,
      'POST /v1/auto-swap/toggle': ai.handleAutoSwapToggle,
      'POST /v1/auto-swap/benchmark': ai.handleAutoSwapBenchmark,
    });
  } catch { /* ai-handlers module optional — serve.ts proxy can run without them */ }

  // Video generation (wan-i2v GPU)
  try {
    const vh = require('../../video-handlers');
    Object.assign(handlers, {
      'POST /v1/video/generate': vh.handleVideoGenerate,
    });
  } catch (e: any) {
    log.warn(`[routes/inference] video-handlers not loaded: ${e.message?.slice(0, 80)}`);
  }

  // Playground
  try {
    const pg = require('../../playground-handlers');
    Object.assign(handlers, {
      'GET /v1/playground/catalog': pg.handlePlaygroundCatalog,
      'POST /v1/playground/stt': pg.handlePlaygroundStt,
      'POST /v1/playground/llm': pg.handlePlaygroundLlm,
      'POST /v1/playground/tts': pg.handlePlaygroundTts,
      'POST /v1/playground/pipeline': pg.handlePlaygroundPipeline,
    });
  } catch { /* playground handlers are optional — absent module means feature off */ }
}
