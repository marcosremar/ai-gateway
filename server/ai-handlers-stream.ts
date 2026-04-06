// ── BabelCast Gateway — SSE Streaming Pipeline Handler ──────────────────────
// POST /v1/speech/stream → Server-Sent Events with per-stage progress + audio.
// Accepts both raw audio body (Content-Type: audio/wav) and FormData (SDK client).

import type { IncomingMessage, ServerResponse } from 'http';
import { runStreamingPipeline } from './pipeline-runner';
import type { PipelineCallbacks, PipelineResult } from './pipeline-runner';
import { getOrCreateRequestId, setRequestIdHeader, readRawBody, validateLang, BodyTimeoutError } from './http-utils';

function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Parse multipart/form-data body to extract audio file and fields. */
async function parseFormData(req: IncomingMessage): Promise<{ audio: Buffer; fields: Record<string, string> }> {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
  if (!boundaryMatch) throw new Error('Missing multipart boundary');
  const boundary = boundaryMatch[1] || boundaryMatch[2];

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const bodyStr = body.toString('latin1');
      const parts = bodyStr.split(`--${boundary}`).slice(1, -1); // skip preamble and epilogue

      let audio = Buffer.alloc(0);
      const fields: Record<string, string> = {};

      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd);
        const value = part.slice(headerEnd + 4).replace(/\r\n$/, '');

        const nameMatch = headers.match(/name="([^"]+)"/);
        if (!nameMatch) continue;
        const name = nameMatch[1];

        if (name === 'audio' || headers.includes('filename=')) {
          // Binary file — extract from original buffer using byte offsets
          const partStart = body.indexOf(Buffer.from(part.slice(0, 40), 'latin1'));
          if (partStart >= 0) {
            const dataStart = partStart + headerEnd + 4;
            const dataEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`, 'latin1'), dataStart);
            audio = body.subarray(dataStart, dataEnd >= 0 ? dataEnd : undefined);
          }
        } else {
          fields[name] = value;
        }
      }
      resolve({ audio, fields });
    });
  });
}

export async function handlePipelineSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  let audioBuffer: Buffer;
  let source = validateLang(url.searchParams.get('source') || 'fr', 'fr');
  let target = validateLang(url.searchParams.get('target') || 'en', 'en');
  let speaker = url.searchParams.get('speaker') || undefined;
  const style = url.searchParams.get('style') || 'default';
  const sttPrompt = url.searchParams.get('prompt') || '';
  const refId = url.searchParams.get('ref_id') || undefined;

  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    // SDK client sends FormData with 'audio' file field
    try {
      const { audio, fields } = await parseFormData(req);
      audioBuffer = audio;
      if (fields.source) source = validateLang(fields.source, source);
      if (fields.target) target = validateLang(fields.target, target);
      if (fields.language) source = validateLang(fields.language, source);
      if (fields.speaker) speaker = fields.speaker;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `FormData parse error: ${msg}` }));
      return;
    }
  } else {
    // Raw audio body (direct HTTP client)
    const bodyPromise = readRawBody(req, res);
    if (!bodyPromise) return;
    try {
      audioBuffer = await bodyPromise;
    } catch (e) {
      if (e instanceof BodyTimeoutError) {
        res.writeHead(408, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request Timeout' }));
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Body read error: ${msg}` }));
      return;
    }
  }

  if (audioBuffer.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No audio data' }));
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Request-ID': requestId,
  });

  // Track client disconnect to stop pipeline early
  let clientClosed = false;
  res.on('close', () => { clientClosed = true; });

  const safeSseWrite = (event: string, data: unknown) => {
    if (clientClosed) return;
    try { sseWrite(res, event, data); } catch { clientClosed = true; }
  };

  const callbacks: PipelineCallbacks = {
    onStageStart(stage: string) {
      safeSseWrite('status', { stage });
    },
    onStageDone(stage: string, result) {
      if (stage === 'stt' && result.text) {
        safeSseWrite('transcript', { transcript: result.text, latencyMs: result.latencyMs, provider: result.provider });
      } else if (stage === 'llm' && result.text) {
        safeSseWrite('response', { response: result.text, latencyMs: result.latencyMs, provider: result.provider });
      }
    },
    onAudioChunk(chunk: Buffer, isFirst: boolean) {
      safeSseWrite('audio', { chunk: chunk.toString('base64'), isFirst });
    },
    onComplete(result: PipelineResult) {
      if (clientClosed) return;
      safeSseWrite('complete', {
        transcription: result.transcription,
        response: result.translation,
        timing: result.timing,
      });
      try { res.end(); } catch {}
    },
    onError(stage: string, error: Error) {
      if (clientClosed) return;
      safeSseWrite('error', { message: error.message, stage });
      try { res.end(); } catch {}
    },
  };

  const sessionId = url.searchParams.get('session_id') || requestId;
  await runStreamingPipeline(audioBuffer, {
    source, target, speaker, style, sttPrompt, refId, sessionId,
  }, callbacks);
}
