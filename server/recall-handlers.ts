// ── BabelCast Gateway — Recall.ai Bot Handlers ──────────────────────────────
// handleRecallJoin, handleRecallLeave, handleRecallStatus, handleRecallWebhook

import type { IncomingMessage, ServerResponse } from 'http';
import { readJsonBody, handleBodyError } from './http-utils';
import { broadcastWs } from './ws-state';
import { isPrivateUrl } from './ai-handlers';
import { PORT } from './config';

const RECALL_REGIONS: Record<string, string> = {
  'us-east-1':       'https://us-east-1.recall.ai',
  'us-west-2':       'https://us-west-2.recall.ai',
  'eu-central-1':    'https://eu-central-1.recall.ai',
  'ap-northeast-1':  'https://ap-northeast-1.recall.ai',
};

export interface RecallState {
  status: 'idle' | 'creating' | 'joining' | 'in_meeting' | 'leaving' | 'ended' | 'error';
  botId: string;
  meetingUrl: string;
  message: string;
  startedAt: number;
  wsConnected: boolean;  // true when the Recall bot has connected the audio WS
}

export let recallState: RecallState = {
  status: 'idle',
  botId: '',
  meetingUrl: '',
  message: '',
  startedAt: 0,
  wsConnected: false,
};

export function setRecallState(patch: Partial<RecallState>): void {
  Object.assign(recallState, patch);
  console.log(`[recall] ${recallState.status}: ${recallState.message}`);
  broadcastWs({ type: 'recall:status', ...recallState });
}

function getRecallApiKey(): string {
  return process.env.RECALL_API_KEY || '';
}

function getRecallRegion(): string {
  return process.env.RECALL_REGION || 'eu-central-1';
}

function getRecallBaseUrl(region?: string): string {
  return RECALL_REGIONS[region || getRecallRegion()] || RECALL_REGIONS['eu-central-1'];
}

/**
 * Construct the public WSS URL that Recall.ai will connect to for audio streaming.
 *
 * Priority:
 *  1. RECALL_AUDIO_WS_URL env var (explicit override)
 *  2. FLY_APP_NAME → wss://<app>.fly.dev:4001/recall/audio
 *  3. LOCAL_WS_URL env var (local tunneling, e.g. ngrok)
 *
 * Auth: uses RECALL_WS_SECRET (separate from GATEWAY_API_KEY so the gateway key
 * is never embedded in URLs sent to Recall's servers).
 */
function getRecallAudioWsUrl(): string {
  const override = process.env.RECALL_AUDIO_WS_URL;
  if (override) return override;

  const secret = process.env.RECALL_WS_SECRET || '';
  const token = secret ? `?token=${encodeURIComponent(secret)}` : '';

  // Fly.io deployment
  const flyApp = process.env.FLY_APP_NAME;
  if (flyApp) {
    return `wss://${flyApp}.fly.dev:4001/recall/audio${token}`;
  }

  // Local tunnel fallback (e.g. NGROK_URL=wss://abc123.ngrok.io)
  const tunnelBase = process.env.NGROK_URL || process.env.LOCAL_WS_URL;
  if (tunnelBase) {
    const base = tunnelBase.replace(/\/+$/, '');
    return `${base}/recall/audio${token}`;
  }

  // Last resort: localhost (will be rejected by Recall's security rules in production)
  return `ws://localhost:${PORT + 1}/recall/audio${token}`;
}

export async function handleRecallStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const wsUrl = getRecallAudioWsUrl();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...recallState, wsUrl }));
}

export async function handleRecallJoin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const apiKey = getRecallApiKey();
  if (!apiKey) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'RECALL_API_KEY not configured — set it in .env or fly secrets' }));
    return;
  }

  if (recallState.status !== 'idle' && recallState.status !== 'error' && recallState.status !== 'ended') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Recall bot already active (status: ${recallState.status})`, ...recallState }));
    return;
  }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const meetingUrl = (body.meetingUrl as string) || '';
  const botName   = (body.botName  as string) || process.env.RECALL_BOT_NAME || 'BabelCast';
  const region    = (body.region   as string) || getRecallRegion();

  if (!meetingUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'meetingUrl is required' }));
    return;
  }

  if (isPrivateUrl(meetingUrl)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Meeting URL must not point to private/internal networks' }));
    return;
  }

  const wsUrl   = getRecallAudioWsUrl();
  const baseUrl = getRecallBaseUrl(region);

  setRecallState({
    status: 'creating',
    meetingUrl,
    message: 'Creating Recall.ai bot...',
    startedAt: Date.now(),
    wsConnected: false,
    botId: '',
  });

  try {
    const resp = await fetch(`${baseUrl}/api/v1/bot/`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        meeting_url: meetingUrl,
        bot_name: botName,
        real_time_media: {
          websocket_audio_destination_url: wsUrl,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (resp.ok) {
      const data = await resp.json() as { id: string };
      setRecallState({
        status: 'joining',
        botId: data.id,
        message: `Bot created (${data.id.slice(0, 8)}...), joining meeting...`,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ wsUrl, ...recallState, botId: data.id }));
    } else {
      const errText = await resp.text();
      const msg = `Recall API ${resp.status}: ${errText.slice(0, 300)}`;
      setRecallState({ status: 'error', message: msg });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setRecallState({ status: 'error', message: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
}

export async function handleRecallLeave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const botId = recallState.botId;
  if (!botId) {
    setRecallState({ status: 'idle', message: '', wsConnected: false });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, note: 'No active bot' }));
    return;
  }

  const apiKey  = getRecallApiKey();
  const baseUrl = getRecallBaseUrl();

  setRecallState({ status: 'leaving', message: 'Stopping Recall bot...' });

  try {
    await fetch(`${baseUrl}/api/v1/bot/${botId}/leave_call/`, {
      method: 'POST',
      headers: { 'Authorization': `Token ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[recall] Bot ${botId} leave_call sent`);
  } catch (err) {
    console.warn(`[recall] leave_call failed (best-effort): ${err}`);
  }

  setRecallState({ status: 'idle', botId: '', meetingUrl: '', message: 'Bot stopped', wsConnected: false });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

/**
 * POST /v1/recall/webhook — Recall.ai status webhook events.
 *
 * Register this URL in the Recall.ai dashboard under Webhooks.
 * Supported events: bot.joining_call, bot.in_waiting_room,
 *   bot.in_call_recording, bot.call_ended, bot.done, bot.fatal_error.
 */
export async function handleRecallWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Optionally verify the webhook secret
  const expectedSecret = process.env.RECALL_WEBHOOK_SECRET;
  if (expectedSecret) {
    const signature = req.headers['x-recall-signature'] as string | undefined;
    if (!signature || signature !== expectedSecret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid webhook signature' }));
      return;
    }
  }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const event  = (body.event as string) || '';
  const data   = (body.data  as Record<string, unknown>) || {};
  const botId  = (data.bot_id as string) || '';

  console.log(`[recall-webhook] event=${event} bot_id=${botId.slice(0, 8)}`);

  // Only process events for the currently tracked bot
  if (botId && botId !== recallState.botId) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, note: 'stale bot' }));
    return;
  }

  switch (event) {
    case 'bot.joining_call':
      setRecallState({ status: 'joining', message: 'Bot joining meeting...' });
      break;
    case 'bot.in_waiting_room':
      setRecallState({ status: 'joining', message: 'Bot in waiting room' });
      break;
    case 'bot.in_call_not_recording':
    case 'bot.recording_permission_allowed':
    case 'bot.in_call_recording':
      setRecallState({ status: 'in_meeting', message: 'Bot recording in meeting' });
      break;
    case 'bot.call_ended':
    case 'bot.done':
      setRecallState({ status: 'ended', botId: '', meetingUrl: '', wsConnected: false, message: 'Meeting ended' });
      // Auto-reset to idle after 5s so the UI can show the "done" state briefly
      setTimeout(() => {
        if (recallState.status === 'ended') {
          setRecallState({ status: 'idle', message: '' });
        }
      }, 5_000);
      break;
    case 'bot.fatal_error': {
      const errMsg = (data.error as string) || 'Recall bot fatal error';
      setRecallState({ status: 'error', message: errMsg, wsConnected: false });
      break;
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
