// ── Recall.ai Bot Handlers ───────────────────────────────────────────────────
// Manages Recall.ai bot lifecycle via their cloud API.
// Bot joins meetings, streams audio back through our gateway WebSocket.

import type { IncomingMessage, ServerResponse } from 'http';
import { readJsonBody, handleBodyError } from './http-utils';
import { broadcastWs } from './ws-state';
import { createLogger } from '../src/logger';
import { validateInput } from '../src/input-validator';
import { RecallJoinRequestSchema, RecallWebhookRequestSchema } from '../src/contracts';

const log = createLogger('recall-handlers');

// ── Module State ─────────────────────────────────────────────────────────────

type RecallStatus = 'idle' | 'joining' | 'in_meeting' | 'ended' | 'error';

let recallBotId: string | null = null;
let recallBotStatus: RecallStatus = 'idle';
let recallBotMeetingUrl = '';
let recallBotWsConnected = false;
let recallBotMessage = '';

function getRecallApiBase(): string {
  const region = process.env.RECALL_REGION || 'us-west-2';
  // us-west-2 uses the default domain; other regions use {region}.recall.ai
  return region === 'us-west-2'
    ? 'https://api.recall.ai/api/v1'
    : `https://${region}.recall.ai/api/v1`;
}
const RECALL_FETCH_TIMEOUT_MS = 30_000;

export function getRecallState() {
  return { botId: recallBotId, status: recallBotStatus, meetingUrl: recallBotMeetingUrl };
}

/**
 * Live-reading view of the full recall bot state, including ws-connection
 * tracking. Callers read properties lazily so they always observe the
 * latest module state.
 */
export const recallState = {
  get botId() { return recallBotId; },
  get status() { return recallBotStatus; },
  get meetingUrl() { return recallBotMeetingUrl; },
  get wsConnected() { return recallBotWsConnected; },
  get message() { return recallBotMessage; },
};

/**
 * Partial state update — only fields specified in the update object are
 * mutated, others keep their current value. Used from ws-server.ts when
 * the Recall bot connects/disconnects via WebSocket.
 */
export function setRecallState(update: Partial<{
  botId: string | null;
  status: RecallStatus;
  meetingUrl: string;
  wsConnected: boolean;
  message: string;
}>): void {
  if (update.botId !== undefined) recallBotId = update.botId;
  if (update.status !== undefined) recallBotStatus = update.status;
  if (update.meetingUrl !== undefined) recallBotMeetingUrl = update.meetingUrl;
  if (update.wsConnected !== undefined) recallBotWsConnected = update.wsConnected;
  if (update.message !== undefined) recallBotMessage = update.message;
}

export function resetRecallState() {
  recallBotId = null;
  recallBotStatus = 'idle';
  recallBotMeetingUrl = '';
  recallBotWsConnected = false;
  recallBotMessage = '';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getRecallApiKey(): string | undefined {
  return process.env.RECALL_API_KEY;
}

function jsonResponse(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function handleRecallJoin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    handleBodyError(res, err);
    return;
  }

  const validationResult = validateInput(body, RecallJoinRequestSchema);
  if (!validationResult.ok) {
    jsonResponse(res, 400, { error: 'Validation failed', details: validationResult.details });
    return;
  }
  const validated = validationResult.data;

  const meetingUrl = validated.meetingUrl;
  const botName = validated.botName || 'BabelCast';

  if (!meetingUrl) {
    jsonResponse(res, 400, { error: 'meetingUrl is required' });
    return;
  }

  const apiKey = getRecallApiKey();
  if (!apiKey) {
    jsonResponse(res, 500, { error: 'RECALL_API_KEY not configured' });
    return;
  }

  if (recallBotId) {
    jsonResponse(res, 409, { error: 'Recall bot already active', botId: recallBotId, status: recallBotStatus });
    return;
  }

  try {
    const apiBase = getRecallApiBase();
    const resp = await fetch(`${apiBase}/bot`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        meeting_url: meetingUrl,
        bot_name: botName,
      }),
      signal: AbortSignal.timeout(RECALL_FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown error');
      log.error(`Recall.ai API error ${resp.status}: ${errText.slice(0, 200)}`);
      jsonResponse(res, 502, { error: `Recall.ai API error: ${resp.status}` });
      return;
    }

    const data = await resp.json() as Record<string, unknown>;
    recallBotId = (data.id as string) || null;
    recallBotStatus = 'joining';
    recallBotMeetingUrl = meetingUrl;

    broadcastWs({ type: 'recall:status', status: 'joining', message: 'Bot joining meeting...' });
    log.log(`Bot created: id=${recallBotId?.slice(0, 8) ?? '?'} url=${meetingUrl.slice(0, 40)}`);

    jsonResponse(res, 201, { botId: recallBotId, status: 'joining' });
  } catch (err) {
    log.error('Failed to create bot:', err);
    jsonResponse(res, 502, { error: `Failed to reach Recall.ai API: ${(err as Error).message}` });
  }
}

export async function handleRecallLeave(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!recallBotId) {
    jsonResponse(res, 404, { error: 'No active Recall bot' });
    return;
  }

  const apiKey = getRecallApiKey();
  if (!apiKey) {
    jsonResponse(res, 500, { error: 'RECALL_API_KEY not configured' });
    return;
  }

  const botId = recallBotId;

  try {
    const resp = await fetch(`${getRecallApiBase()}/bot/${botId}/leave_call`, {
      method: 'POST',
      headers: { 'Authorization': `Token ${apiKey}` },
      signal: AbortSignal.timeout(RECALL_FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown error');
      log.error(`Recall.ai leave error ${resp.status}: ${errText.slice(0, 200)}`);
      // Still reset state — bot may be gone
    }
  } catch (err) {
    log.error('Failed to stop bot:', err);
    // Still reset state
  }

  recallBotId = null;
  recallBotStatus = 'idle';
  recallBotMeetingUrl = '';

  broadcastWs({ type: 'recall:status', status: 'idle', message: 'Bot stopped' });
  log.log(`Bot stopped: id=${botId.slice(0, 8)}`);

  jsonResponse(res, 200, { status: 'idle', message: 'Bot stopped' });
}

export async function handleRecallStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonResponse(res, 200, {
    botId: recallBotId,
    status: recallBotStatus,
    meetingUrl: recallBotMeetingUrl,
  });
}

export async function handleRecallWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Auth gate — without this, anyone can flip recallBotStatus + broadcast
  // recall:status events to all WS clients (and clear recallBotId).
  // Accept either:
  //   1. shared secret in Authorization: Bearer <RECALL_WEBHOOK_SECRET>
  //   2. HMAC-SHA256 signature in X-Recall-Signature: sha256=<hex>
  // Both checked in constant time. If RECALL_WEBHOOK_SECRET is unset, fall
  // through to localhost-only (request from 127.0.0.1) to avoid breaking
  // local dev. In production set RECALL_WEBHOOK_SECRET.
  const secret = process.env.RECALL_WEBHOOK_SECRET || '';
  let rawBody = '';
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    rawBody = Buffer.concat(chunks).toString('utf-8');
  } catch (err) {
    handleBodyError(res, err);
    return;
  }

  if (secret) {
    const { timingSafeEqual, createHmac } = await import('crypto');
    const safeEq = (a: string, b: string): boolean => {
      if (!a || !b) return false;
      if (a.length !== b.length) {
        try { timingSafeEqual(Buffer.from(a.padEnd(b.length, '\0')), Buffer.from(b.padEnd(a.length, '\0'))); } catch { /* no-op */ }
        return false;
      }
      try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
    };
    const authHeader = (req.headers['authorization'] as string | undefined) || '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    const sigHeader = (req.headers['x-recall-signature'] as string | undefined) || '';
    const expectedSig = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const bearerOk = bearer.length > 0 && safeEq(bearer, secret);
    const sigOk = sigHeader.length > 0 && safeEq(sigHeader, expectedSig);
    if (!bearerOk && !sigOk) {
      jsonResponse(res, 401, { error: 'Recall webhook authentication failed' });
      return;
    }
  } else {
    const remote = req.socket?.remoteAddress || '';
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote.startsWith('127.');
    if (!isLocal) {
      jsonResponse(res, 401, { error: 'RECALL_WEBHOOK_SECRET not configured — non-localhost rejected' });
      return;
    }
  }

  let body: Record<string, unknown>;
  try {
    body = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch (err) {
    handleBodyError(res, err);
    return;
  }

  const validationResult = validateInput(body, RecallWebhookRequestSchema);
  if (!validationResult.ok) {
    jsonResponse(res, 400, { error: 'Validation failed', details: validationResult.details });
    return;
  }
  const validated = validationResult.data;

  const event = validated.event || '';
  const data = validated.data || {};

  // Sanitize against log injection (newlines could forge log entries).
  const safeEvent = String(event).replace(/[\r\n\t]/g, '_').slice(0, 80);
  const safeBotId = String(data.bot_id ?? '?').replace(/[\r\n\t]/g, '_').slice(0, 80);
  log.log(`event=${safeEvent} bot_id=${safeBotId}`);

  // Map Recall.ai webhook events to our status
  const statusCode = ((data.status ?? {}) as Record<string, unknown>).code as string | undefined;

  if (statusCode === 'in_call_not_recording' || statusCode === 'in_call_recording') {
    recallBotStatus = 'in_meeting';
    broadcastWs({
      type: 'recall:status',
      status: 'in_meeting',
      message: 'Bot is in the meeting',
      wsConnected: statusCode === 'in_call_recording',
    });
  } else if (statusCode === 'call_ended' || statusCode === 'done') {
    recallBotStatus = 'ended';
    recallBotId = null;
    recallBotMeetingUrl = '';
    broadcastWs({ type: 'recall:status', status: 'ended', message: 'Meeting ended' });
  } else if (statusCode === 'fatal') {
    recallBotStatus = 'error';
    const errorMsg = typeof data.status_changes === 'string' ? data.status_changes : 'Bot error';
    broadcastWs({ type: 'recall:status', status: 'error', message: errorMsg });
  }

  // Always acknowledge
  jsonResponse(res, 200, { received: true });
}
