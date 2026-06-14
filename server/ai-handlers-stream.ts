// ── BabelCast Gateway — SSE Streaming Pipeline Handler ──────────────────────
// POST /v1/speech/stream → Server-Sent Events with per-stage progress + audio.
// Accepts both raw audio body (Content-Type: audio/wav) and FormData (SDK client).

import type { IncomingMessage, ServerResponse } from 'http';
import { runStreamingPipeline } from './pipeline-runner';
import type { PipelineCallbacks, PipelineResult } from './pipeline-runner';
import { getOrCreateRequestId, setRequestIdHeader, readRawBody, validateLang, BodyTimeoutError } from './http-utils';
import { TRANSLATION_STYLES } from '../src/gateway/pipeline/system-prompt';
import { createLogger } from '../src/logger';

const log = createLogger('pipeline-sse');

/**
 * Validate a translation style against the known set. Unknown styles silently
 * fell back to "default" inside buildSystemPrompt — warn so a typo'd style
 * isn't invisibly ignored, then use the safe default.
 */
function validateStyle(style: string): string {
  if (style in TRANSLATION_STYLES) return style;
  log.warn(`Unknown translation style "${style}" — falling back to "default" (valid: ${Object.keys(TRANSLATION_STYLES).join(', ')})`);
  return 'default';
}

function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Parse a multipart/form-data body directly on the Buffer (#82/#83).
 *
 * The previous implementation (a) `body.toString('latin1')` copied the entire
 * multi-MB audio into a JS string, and (b) for each part re-scanned the whole
 * body with `indexOf(Buffer.from(part.slice(0,40)))` — O(n²) on large audio.
 *
 * This walks the body once, locating `--boundary` delimiters on the raw bytes
 * and slicing parts as zero-copy `subarray` views. Headers (small, ASCII) are
 * decoded to find the field name / filename; binary part values are kept as
 * Buffers. Pure and synchronous — unit-testable with a hand-built buffer.
 */
export function parseMultipart(body: Buffer, boundary: string): { audio: Buffer; fields: Record<string, string> } {
  const delimiter = Buffer.from(`--${boundary}`);
  const HEADER_SEP = Buffer.from('\r\n\r\n');

  let audio: Buffer = Buffer.alloc(0);
  const fields: Record<string, string> = {};

  // Find each delimiter occurrence in one forward pass.
  const bounds: number[] = [];
  let from = 0;
  for (;;) {
    const idx = body.indexOf(delimiter, from);
    if (idx === -1) break;
    bounds.push(idx);
    from = idx + delimiter.length;
  }

  // Each part lives between consecutive delimiters. Skip the final closing
  // delimiter ("--boundary--") which has no following part.
  for (let i = 0; i < bounds.length - 1; i++) {
    // Part body starts after the delimiter and its trailing CRLF.
    let partStart = bounds[i] + delimiter.length;
    if (body[partStart] === 0x0d && body[partStart + 1] === 0x0a) partStart += 2; // skip CRLF
    // Part ends just before the next delimiter's leading CRLF.
    let partEnd = bounds[i + 1];
    if (body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) partEnd -= 2; // strip trailing CRLF

    if (partEnd <= partStart) continue;

    const headerSep = body.indexOf(HEADER_SEP, partStart);
    if (headerSep === -1 || headerSep >= partEnd) continue;

    const headers = body.toString('utf8', partStart, headerSep); // small ASCII header block
    const dataStart = headerSep + HEADER_SEP.length;

    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    if (name === 'audio' || headers.includes('filename=')) {
      audio = body.subarray(dataStart, partEnd); // zero-copy view of the binary
    } else {
      fields[name] = body.toString('utf8', dataStart, partEnd);
    }
  }

  return { audio, fields };
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
      resolve(parseMultipart(Buffer.concat(chunks), boundary));
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
  const style = validateStyle(url.searchParams.get('style') || 'default');
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
        // Echo the resolved language pair so clients can confirm what was
        // actually used (defaults are silent; relevant once auto-detect lands).
        source,
        target,
      });
      try { res.end(); } catch { /* best-effort: cleanup or optional side-effect */ }
    },
    onError(stage: string, error: Error) {
      if (clientClosed) return;
      safeSseWrite('error', { message: error.message, stage });
      try { res.end(); } catch { /* best-effort: cleanup or optional side-effect */ }
    },
  };

  const sessionId = url.searchParams.get('session_id') || requestId;
  await runStreamingPipeline(audioBuffer, {
    source, target, speaker, style, sttPrompt, refId, sessionId,
  }, callbacks);
}
