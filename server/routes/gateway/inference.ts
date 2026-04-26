/**
 * Inference routes — AI pipeline endpoints
 *
 * Routes:
 *   GET  /v1/models                  — OpenAI-compatible model catalog
 *   POST /v1/transcribe              — Speech-to-text
 *   POST /v1/transcribe/ensemble     — Ensemble transcription
 *   POST /v1/ensemble-transcribe     — Legacy ensemble transcription alias
 *   POST /v1/chat/completions        — LLM chat completions
 *   POST /v1/translate               — Translation
 *   POST /v1/tts/preview             — TTS preview
 *   POST /v1/speech                  — Full STT->LLM->TTS pipeline
 *   POST /v1/detect-language         — Language detection
 *   GET  /v1/analytics/system        — System analytics dashboard
 *   GET  /v1/auto-swap/status        — Auto-swap provider status
 *   POST /v1/auto-swap/toggle        — Toggle auto-swap
 *   POST /v1/auto-swap/benchmark     — Run auto-swap benchmark
 *   POST /v1/video/generate          — Video generation (wan-i2v GPU)
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
  const fakeReq = new PassThrough() as IncomingMessage;
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

async function handleImageGenerateCompat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
    return;
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
  if (Buffer.isBuffer(proxyRes.body) || proxyRes.body instanceof Uint8Array) {
    res.writeHead(proxyRes.status, headers);
    res.end(proxyRes.body);
  } else {
    res.writeHead(proxyRes.status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(proxyRes.body));
  }
}

/**
 * GET /v1/models — OpenAI-compatible model list derived from active app's pipeline chain.
 */
async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const models = new Map<string, { id: string; object: 'model'; created: number; owned_by: string; capability: string }>();

  try {
    const cfg = require('../../config-persistence');
    const app = await cfg.getActiveApp?.();
    const add = (capability: string, providers: Array<{ provider?: string; model?: string }> | undefined) => {
      if (!Array.isArray(providers)) return;
      for (const p of providers) {
        const id = p?.model;
        if (!id || models.has(id)) continue;
        models.set(id, { id, object: 'model', created: now, owned_by: p.provider || 'ai-gateway', capability });
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
      'POST /v1/translate': ai.handleTranslate,
      'POST /v1/tts': ai.handleTtsPreview,
      'POST /v1/tts-preview': ai.handleTtsPreview,
      'POST /v1/tts/preview': ai.handleTtsPreview,
      'GET /v1/tts/voices': handleTtsVoices,
      'POST /v1/audio/speech': (req: IncomingMessage, res: ServerResponse) => handleAudioSpeechCompat(req, res, ai),
      'POST /v1/images/generate': handleImageGenerateCompat,
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
