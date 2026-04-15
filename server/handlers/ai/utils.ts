/**
 * AI Handlers Utilities
 */

import type { IncomingMessage } from 'http';
import { createLogger } from '../../../src/logger';

const log = createLogger('ai-utils');

/**
 * Parse request body as JSON
 */
export async function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Parse request body as raw Buffer
 */
export async function parseRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/**
 * Extract audio from multipart form data
 */
export async function extractAudioFromMultipart(req: IncomingMessage): Promise<{
  audio: Buffer;
  language?: string;
  prompt?: string;
}> {
  const body = await parseRawBody(req);
  
  // Simple multipart parsing (for production, use a library like formidable)
  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.split('boundary=')[1];
  
  if (!boundary) {
    throw new Error('No boundary in multipart content type');
  }
  
  const parts = body.toString().split(`--${boundary}`);
  let audio: Buffer | null = null;
  let language: string | undefined;
  let prompt: string | undefined;
  
  for (const part of parts) {
    if (part.includes('Content-Disposition')) {
      if (part.includes('name="file"')) {
        const binaryStart = part.indexOf('\r\n\r\n') + 4;
        const binaryEnd = part.lastIndexOf('\r\n');
        audio = Buffer.from(part.slice(binaryStart, binaryEnd), 'binary');
      } else if (part.includes('name="language"')) {
        const valueStart = part.indexOf('\r\n\r\n') + 4;
        const valueEnd = part.lastIndexOf('\r\n');
        language = part.slice(valueStart, valueEnd).trim();
      } else if (part.includes('name="prompt"')) {
        const valueStart = part.indexOf('\r\n\r\n') + 4;
        const valueEnd = part.lastIndexOf('\r\n');
        prompt = part.slice(valueStart, valueEnd).trim();
      }
    }
  }
  
  if (!audio) {
    throw new Error('No audio file found in multipart request');
  }
  
  return { audio, language, prompt };
}

/**
 * Send JSON response
 */
export function sendJson(
  res: import('http').ServerResponse,
  data: unknown,
  statusCode: number = 200
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send error response
 */
export function sendError(
  res: import('http').ServerResponse,
  message: string,
  statusCode: number = 500,
  details?: Record<string, unknown>
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: message,
    ...(details && { details }),
  }));
}

/**
 * Send audio response
 */
export function sendAudio(
  res: import('http').ServerResponse,
  audio: Buffer,
  format: string = 'wav',
  duration?: number
): void {
  const contentType = format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': audio.length,
    'X-Audio-Duration': String(duration || 0),
  });
  res.end(audio);
}

/**
 * Generate request ID
 */
export function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Log request with timing
 */
export function logRequestTiming(
  requestId: string,
  stage: string,
  startTime: number,
  provider?: string,
  success?: boolean
): void {
  const duration = Date.now() - startTime;
  log.log(`[${requestId}] ${stage} completed in ${duration}ms`, {
    provider,
    success,
    duration,
  });
}

/**
 * Filter hallucinations from STT text
 */
export function filterHallucinations(
  text: string,
  config?: {
    blockedPhrases?: string[];
    minConfidence?: number;
  }
): { text: string; filtered: boolean } {
  const blockedPhrases = config?.blockedPhrases || [
    'thank you for watching',
    'subscribe to my channel',
    'like and subscribe',
  ];
  
  let filtered = false;
  let result = text;
  
  for (const phrase of blockedPhrases) {
    if (result.toLowerCase().includes(phrase)) {
      result = result.replace(new RegExp(phrase, 'gi'), '');
      filtered = true;
    }
  }
  
  // Clean up extra spaces
  result = result.replace(/\s+/g, ' ').trim();
  
  return { text: result, filtered };
}

/**
 * Build SSE stream response
 */
export function createSseStream(
  res: import('http').ServerResponse
): (data: unknown) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  
  return (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

/**
 * Parse query parameters from URL
 */
export function parseQueryParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  const queryString = url.split('?')[1];
  
  if (queryString) {
    const pairs = queryString.split('&');
    for (const pair of pairs) {
      const [key, value] = pair.split('=');
      if (key) {
        params[decodeURIComponent(key)] = decodeURIComponent(value || '');
      }
    }
  }
  
  return params;
}

/**
 * Check if request wants streaming response
 */
export function wantsStream(req: IncomingMessage): boolean {
  return req.headers.accept?.includes('text/event-stream') || false;
}

/**
 * Check if request wants binary audio response
 */
export function wantsBinaryAudio(req: IncomingMessage): boolean {
  return req.headers.accept?.includes('audio/') || false;
}
