/**
 * Bot Proxy — Status, Streaming Proxy, Debug Proxy
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readJsonBody, handleBodyError } from '../../http-utils';
import { validateInput } from '../../../src/input-validator';
import { BotStreamPageRequestSchema } from '../../../src/contracts';
import {
  log, botState, setBotState, botHeaders,
} from './bot-shared';

export async function handleBotStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const elapsed = botState.startedAt > 0 ? Math.round((Date.now() - botState.startedAt) / 1000) : 0;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ...botState,
    elapsedSec: elapsed,
    webcamRtmpUrl: botState.webcamRtmpUrl,
    youtubeStreamKey: botState.youtubeStreamKey ? `${botState.youtubeStreamKey.slice(0, 4)}****` : '',
  }));
}

export async function handleBotStreamPage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const streamResult = validateInput(body, BotStreamPageRequestSchema);
  if (!streamResult.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Validation failed', details: streamResult.details }));
    return;
  }

  if (botState.status !== 'joined') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Bot not in a meeting (status: ${botState.status})` }));
    return;
  }

  const ep = botState.endpoint;
  if (!ep) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bot pod has no endpoint' }));
    return;
  }

  try {
    const apiRes = await fetch(`${ep}/stream-page`, {
      method: 'POST',
      headers: botHeaders(),
      body: JSON.stringify(streamResult.data),
      signal: AbortSignal.timeout(60_000),
    });
    const isJson = (apiRes.headers.get('content-type') ?? '').includes('application/json');
    const result = isJson
      ? await apiRes.json().catch(() => ({}))
      : { raw: await apiRes.text().catch(() => '') };
    res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `stream-page proxy failed: ${(err as Error).message}` }));
  }
}

export async function handleBotStopStream(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ep = botState.endpoint;
  if (!ep) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bot pod has no endpoint' }));
    return;
  }

  try {
    const apiRes = await fetch(`${ep}/stop-stream`, {
      method: 'POST',
      headers: botHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    const isJson = (apiRes.headers.get('content-type') ?? '').includes('application/json');
    const result = isJson
      ? await apiRes.json().catch(() => ({}))
      : { raw: await apiRes.text().catch(() => '') };
    res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `stop-stream proxy failed: ${(err as Error).message}` }));
  }
}

export async function handleBotStreamStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ep = botState.endpoint;
  if (!ep) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ streaming: false, reason: 'No bot pod' }));
    return;
  }

  try {
    const apiRes = await fetch(`${ep}/stream-status`, {
      headers: botHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    const isJson = (apiRes.headers.get('content-type') ?? '').includes('application/json');
    const result = isJson
      ? await apiRes.json().catch(() => ({}))
      : { raw: await apiRes.text().catch(() => '') };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ streaming: false, reason: `Bot unreachable: ${(err as Error).message}` }));
  }
}

export async function handleBotProxyBinary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ep = botState.endpoint;
  if (!ep) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No bot pod' }));
    return;
  }
  const proxyPath = (req.url || '').replace(/^\/v1\/bot/, '') || '/';
  try {
    const apiRes = await fetch(`${ep}${proxyPath}`, {
      method: req.method || 'GET',
      headers: botHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    const buf = Buffer.from(await apiRes.arrayBuffer());
    const ct = apiRes.headers.get('content-type') || 'application/octet-stream';
    res.writeHead(apiRes.status, { 'Content-Type': ct, 'Content-Length': buf.length.toString() });
    res.end(buf);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy failed: ${(err as Error).message}` }));
  }
}

export async function handleBotProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ep = botState.endpoint;
  if (!ep) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No bot pod' }));
    return;
  }

  const proxyPath = (req.url || '').replace(/^\/v1\/bot/, '') || '/';

  try {
    const apiRes = await fetch(`${ep}${proxyPath}`, {
      method: req.method || 'GET',
      headers: botHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await apiRes.text();
    res.writeHead(apiRes.status, { 'Content-Type': apiRes.headers.get('content-type') || 'application/json' });
    res.end(result);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy failed: ${(err as Error).message}` }));
  }
}
