// ── WebSocket command handlers (JSON command messages from clients) ──────────
// handleWsCommand dispatches commands sent over the bot events WS channel.

import { createLogger } from '../../src/logger';
import { botState } from '../state';
import { broadcastWs, subscribeDub, unsubscribeDub, getActiveTargets, stopBotTranscriptPoll, isValidDubTarget } from '../ws-state';
import type { BabelCastWS } from '../ws-state';
import { setBotState, isPrivateUrl, isPrivateUrlResolved } from '../bot-handlers';
import { PORT } from '../config';
import { speculativeCache } from '../speculative-cache';
import { getLabsFlags } from '../labs-settings';
import { setBotLangPair, resetBotLangPair, startParecCapture, stopParecCapture, buildSpeculativeTranslateFn } from './bot-audio';

const log = createLogger('ws-handlers');

/** Command types the bot-events channel understands (#482/#485). */
export const KNOWN_WS_COMMANDS = new Set([
  'bot:join', 'bot:leave',
  'dub:subscribe', 'dub:switch', 'dub:unsubscribe',
  'speculation:feed', 'ping',
]);

/** True when `cmd.type` is a string naming a command we handle (#482/#485). */
export function isKnownWsCommand(cmd: Record<string, unknown>): boolean {
  return typeof cmd.type === 'string' && KNOWN_WS_COMMANDS.has(cmd.type);
}

export async function handleWsCommand(ws: BabelCastWS, cmd: Record<string, unknown>): Promise<void> {
  // Reject malformed / unknown commands so typos get explicit feedback instead
  // of silently no-op'ing (#482 shape, #485 unknown-command nack).
  if (!isKnownWsCommand(cmd)) {
    try { ws.send(JSON.stringify({ type: 'error', code: 'unknown_command', received: typeof cmd.type === 'string' ? cmd.type : null })); } catch { /* socket closing */ }
    return;
  }
  const type = cmd.type as string;
  log.log(`[ws] Command from client: ${type}`);

  try {

  if (type === 'bot:join') {
    const meetingUrl = (cmd.meetingUrl as string) ?? '';
    const sourceLang = (cmd.sourceLang as string) ?? 'fr';
    const targetLang = (cmd.targetLang as string) ?? 'en';
    const botName = (cmd.botName as string) ?? 'BabelCast Bot';

    // Store language pair for bot audio pipeline (getBotSourceTarget)
    setBotLangPair(
      (cmd.source as string) || sourceLang,
      (cmd.target as string) || targetLang,
    );

    if (!meetingUrl) {
      ws.send(JSON.stringify({ type: 'error', message: 'meetingUrl is required' }));
      return;
    }
    // Validate meeting URL format and protocol
    try {
      const parsed = new URL(meetingUrl);
      if (!['https:', 'http:'].includes(parsed.protocol)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid meeting URL: must be http or https' }));
        return;
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid meeting URL format' }));
      return;
    }
    // SSRF protection — block private/internal network URLs
    if (isPrivateUrl(meetingUrl) || await isPrivateUrlResolved(meetingUrl)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Meeting URL must not point to private/internal networks' }));
      return;
    }
    if (botState.status !== 'ready') {
      ws.send(JSON.stringify({ type: 'error', message: `Bot pod not ready (status: ${botState.status})` }));
      return;
    }

    // Directly call the join logic inline (bypassing the HTTP handler reuse
    // — previous fake-IncomingMessage approach was removed as dead code).
    const botEndpoint = botState.endpoint;
    if (!botEndpoint) {
      broadcastWs({ type: 'bot:status', status: 'error', message: 'Bot pod has no endpoint' });
      return;
    }

    const botUuid = crypto.randomUUID();
    // For local Docker: use parec (PulseAudio) capture — much more reliable than Web Audio API.
    // Only set streaming_output for RunPod bots (no parec available remotely).
    const isLocalBot = botState.podId === 'local';
    const streamingOutput = isLocalBot
      ? ''  // parec handles audio capture for local Docker
      : `ws://localhost:${PORT + 1}/ws/bot-audio`;
    const config = {
      meeting_url: meetingUrl,
      bot_name: botName,
      bot_uuid: botUuid,
      streaming_output: streamingOutput,
      streaming_audio_frequency: 48000,
      recording_mode: 'speaker_view',
      remote: null,
      speech_to_text_provider: 'Default',
      automatic_leave: { waiting_room_timeout: 600, noone_joined_timeout: 300, silence_timeout: 600 },
      _source_lang: sourceLang,
      _target_lang: targetLang,
    };

    setBotState({ botId: botUuid, meetingUrl, status: 'joined', message: `Bot joining: ${meetingUrl}` });
    broadcastWs({ type: 'bot:status', status: 'joining', message: `Bot joining meeting...` });

    try {
      const { botPodApiKey } = await import('../state');
      const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (botPodApiKey) authHeaders['Authorization'] = `Bearer ${botPodApiKey}`;
      const joinRes = await fetch(`${botEndpoint}/join`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(config),
        signal: AbortSignal.timeout(30_000),
      });
      const joinBody = await joinRes.json().catch(() => ({}));
      if (joinRes.ok) {
        broadcastWs({ type: 'bot:status', status: 'in_meeting', message: 'Bot joined meeting' });
        // Start PulseAudio capture for local Docker (much more reliable than Web Audio API)
        startParecCapture();
      } else {
        broadcastWs({ type: 'bot:status', status: 'error', message: `Join failed: ${JSON.stringify(joinBody)}` });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('bot:join failed: %s', errMsg);
      broadcastWs({ type: 'bot:status', status: 'error', message: `Join failed: ${errMsg}` });
    }

  } else if (type === 'bot:leave') {
    stopParecCapture();
    stopBotTranscriptPoll();
    // Reset language pair to defaults
    resetBotLangPair();
    const endpoint = botState.endpoint;
    if (!endpoint) {
      broadcastWs({ type: 'bot:status', status: 'idle', message: 'Bot not active' });
      return;
    }
    try {
      await fetch(`${endpoint}/stop_record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meeting_url: botState.meetingUrl }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { /* ignore */ }
    setBotState({ status: 'ready', message: 'Bot left meeting', meetingUrl: '', botId: '' });
    broadcastWs({ type: 'bot:status', status: 'idle', message: 'Bot left meeting' });

  } else if (type === 'dub:subscribe' || type === 'dub:switch') {
    const target = String(cmd.target || '');
    if (!target) {
      ws.send(JSON.stringify({ type: 'error', message: 'target is required for dub:subscribe' }));
      return;
    }
    // Reject bogus targets before they become an unbounded Map key (#483).
    if (!isValidDubTarget(target)) {
      ws.send(JSON.stringify({ type: 'error', code: 'invalid_target', message: 'target must be a 2-8 char language code' }));
      return;
    }
    const binaryAudio = cmd.binaryAudio === true;
    subscribeDub(ws.data.id, ws, target, binaryAudio);
    ws.send(JSON.stringify({ type: 'dub:subscribed', target, binaryAudio, activeTargets: getActiveTargets() }));

  } else if (type === 'dub:unsubscribe') {
    unsubscribeDub(ws.data.id);
    ws.send(JSON.stringify({ type: 'dub:unsubscribed' }));

  } else if (type === 'speculation:feed') {
    // Feed a partial ASR result into the speculative translation cache.
    // The client sends: { type: 'speculation:feed', sessionId, text, source, target, style? }
    const labs = getLabsFlags();
    if (!labs.speculativeTranslation) return; // no-op when flag is off

    const sessionId = String(cmd.sessionId || '');
    const text = String(cmd.text || '');
    const source = String(cmd.source || 'fr');
    const target = String(cmd.target || 'en');
    const style = String(cmd.style || 'default');

    if (!sessionId || !text.trim()) return;

    const translateFn = buildSpeculativeTranslateFn(source, target, style);
    try { speculativeCache.speculate(sessionId, text, translateFn); } catch (e) { log.warn('[ws] speculative translate failed:', e instanceof Error ? e.message : e); }

  } else if (type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
  }
  } catch (err) {
    log.error('Command error: %s', err instanceof Error ? err.message : err);
    ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
  }
}
