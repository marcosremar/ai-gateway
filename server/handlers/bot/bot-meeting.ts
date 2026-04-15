/**
 * Bot Meeting — Join, Leave, Watchdog, Idle Shutdown
 */

import type { IncomingMessage, ServerResponse } from 'http';
import {
  botState, setBotStateVar, botApiKey, deployApiKey, deployState,
} from '../../state';
import { flyio } from '../../providers';
import { maskKey } from '../../http-utils';
import { readJsonBody, handleBodyError } from '../../http-utils';
import { broadcastWs, startBotTranscriptPoll, stopBotTranscriptPoll } from '../../ws-state';
import { warmupAllGpuModels } from '../../provider-warmup';
import { isPrivateUrl } from '../../ai-handlers';
import { validateInput } from '../../../src/input-validator';
import { BotJoinRequestSchema } from '../../../src/contracts';
import { PORT } from '../../config';
import {
  log, BOT_DOCKER_IMAGE, BOT_IDLE_SHUTDOWN_MS,
  setBotState, redactMeetingUrl, botHeaders,
  getBotIdleTimer, setBotIdleTimer,
  incrementBotWatchdogGen, getBotWatchdogGen,
} from './bot-shared';
import { startBotAudioPull, stopBotAudioPull } from './bot-audio-pull';

export function clearBotIdleTimer() {
  const timer = getBotIdleTimer();
  if (timer) { clearTimeout(timer); setBotIdleTimer(null); }
}

export function scheduleBotIdleShutdown() {
  clearBotIdleTimer();
  log.log(`[bot] Meeting ended — auto-terminate in ${BOT_IDLE_SHUTDOWN_MS / 60_000} min if not rejoined`);
  const timer = setTimeout(async () => {
    setBotIdleTimer(null);
    if (botState.status !== 'ready') return;
    log.log(`[bot] Auto-terminating idle bot pod after ${BOT_IDLE_SHUTDOWN_MS / 60_000} min`);
    try {
      const podId = botState.podId;
      const apiKey = botApiKey || deployApiKey || process.env.RUNPOD_API_KEY || '';
      const flyKey = process.env.FLY_API_TOKEN || '';
      setBotStateVar({ status: 'idle', podId: '', endpoint: '', sshHost: '', sshPort: 0, message: '', startedAt: 0, botId: '', meetingUrl: '', webcamRtmpUrl: '', youtubeStreamKey: '' });
      const { setBotDeployLock } = await import('../../state');
      setBotDeployLock(false);
      if (podId && podId !== 'local') {
        if (flyKey && botState.endpoint?.includes('.fly.dev')) {
          await flyio.deleteInstance(podId, { apiKey: flyKey }).catch(() => {});
        } else if (apiKey) {
          const { runpod } = await import('../../providers');
          await runpod.deleteInstance(podId, { apiKey }).catch(() => {});
        }
      }
    } catch (e) {
      log.warn('[bot] Auto-terminate failed:', e instanceof Error ? e.message : e);
    }
  }, BOT_IDLE_SHUTDOWN_MS) as unknown as Timer;
  setBotIdleTimer(timer);
}

export async function handleBotJoin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const joinResult = validateInput(body, BotJoinRequestSchema);
  if (!joinResult.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Validation failed', details: joinResult.details }));
    return;
  }
  const joinData = joinResult.data;

  const meetingUrl = joinData.meetingUrl;
  const botName = joinData.botName || 'BabelCast Bot';
  const sourceLang = joinData.source || 'fr';
  const targetLang = joinData.target || 'en';
  const streamKey = joinData.streamKey || '';

  if (!meetingUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'meetingUrl is required' }));
    return;
  }

  try {
    const parsed = new URL(meetingUrl);
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid meeting URL: must be http or https' }));
      return;
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid meeting URL format' }));
    return;
  }

  if (isPrivateUrl(meetingUrl)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Meeting URL must not point to private/internal networks' }));
    return;
  }

  if (botState.status !== 'ready') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Bot pod not ready (status: ${botState.status})`, ...botState }));
    return;
  }

  const isLocalBot = botState.podId === 'local';
  const publicWsUrl = process.env.GATEWAY_PUBLIC_WS_URL;
  const streamingOutput = isLocalBot
    ? ''
    : publicWsUrl
      ? `${publicWsUrl}/ws/bot-audio`
      : `ws://localhost:${PORT + 1}/ws/bot-audio`;

  const botUuid = crypto.randomUUID();
  const config = {
    meeting_url: meetingUrl,
    bot_name: botName,
    bot_uuid: botUuid,
    streaming_output: streamingOutput,
    streaming_audio_frequency: 48000,
    recording_mode: 'speaker_view',
    remote: null,
    speech_to_text_provider: 'Default',
    automatic_leave: {
      waiting_room_timeout: 600,
      noone_joined_timeout: 300,
      silence_timeout: 600,
    },
    _source_lang: sourceLang,
    _target_lang: targetLang,
  };

  const botEndpoint = botState.endpoint;
  if (!botEndpoint) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bot pod has no endpoint' }));
    return;
  }

  setBotState({
    botId: botUuid, meetingUrl, status: 'joining',
    message: `Bot joining: ${redactMeetingUrl(meetingUrl)}`,
    youtubeStreamKey: streamKey,
  });

  try {
    const joinRes = await fetch(`${botEndpoint}/join`, {
      method: 'POST',
      headers: botHeaders(),
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(30_000),
    });
    const ct = joinRes.headers.get('content-type') ?? '';
    const joinBody = ct.includes('application/json')
      ? await joinRes.json().catch(() => ({}))
      : await joinRes.text().catch(() => '');
    if (!joinRes.ok) {
      const errDetail = typeof joinBody === 'string' ? joinBody : JSON.stringify(joinBody);
      log.warn(`[bot] /join returned ${joinRes.status}: ${errDetail}`);
      setBotState({ status: 'ready', message: `Bot /join failed (HTTP ${joinRes.status}): ${errDetail.slice(0, 100)}` });
    } else {
      log.log(`[bot] /join OK: ${JSON.stringify(joinBody)}`);
      setBotState({ status: 'joined' });
      broadcastWs({ type: 'bot:status', status: 'joining', message: 'Bot connecting to meeting...' });

      (async () => {
        const { getBotAudioChunks } = await import('../../ws-server');
        const startChunks = getBotAudioChunks();
        for (let i = 0; i < 90; i++) {
          await new Promise(r => setTimeout(r, 2000));
          if (botState.status !== 'joined') break;
          if (getBotAudioChunks() > startChunks + 5) {
            broadcastWs({ type: 'bot:status', status: 'in_meeting', message: 'Bot joined meeting' });
            log.log(`[bot] Bot confirmed in meeting (audio chunks: ${getBotAudioChunks() - startChunks})`);
            break;
          }
        }
      })().catch(() => {});

      (async () => {
        const flyHost = flyio.getFlyHost();
        const probeUrl = flyHost
          ? `https://${flyHost}/version`
          : `${botEndpoint}/version`;
        const probeHeaders: Record<string, string> = {};
        if (flyHost) probeHeaders['Host'] = flyHost;
        if (botState.podId && botState.podId !== 'local') probeHeaders['fly-force-instance-id'] = botState.podId;
        const probeFetchOpts: Record<string, unknown> = { headers: probeHeaders, signal: AbortSignal.timeout(5000) };
        if (!flyHost && botEndpoint.includes('https://')) {
          (probeFetchOpts as any).tls = { rejectUnauthorized: false };
        }
        log.log(`[bot-watchdog] Probing ${probeUrl} every 10s (machine-id=${botState.podId ?? 'n/a'})`);

        const myGen = incrementBotWatchdogGen();

        let wasInMeeting = false;
        let reconnectAttempts = 0;
        let consecutiveProbeFailures = 0;
        const MAX_RECONNECTS = 3;
        const MAX_PROBE_FAILURES = 6;

        while (botState.status === 'joined' && botState.meetingUrl && myGen === getBotWatchdogGen()) {
          await new Promise(r => setTimeout(r, 10_000));
          if (botState.status !== 'joined') break;

          try {
            const r = await fetch(probeUrl, { ...probeFetchOpts, signal: AbortSignal.timeout(5000) } as any);
            if (r.ok) {
              consecutiveProbeFailures = 0;
              const data = await r.json() as { status?: string };
              if (data.status === 'meeting_active') {
                wasInMeeting = true;
                reconnectAttempts = 0;
              } else if (data.status === 'idle' && wasInMeeting && reconnectAttempts < MAX_RECONNECTS) {
                reconnectAttempts++;
                log.log(`[bot] Bot dropped from meeting — auto-rejoin attempt ${reconnectAttempts}/${MAX_RECONNECTS}`);
                broadcastWs({ type: 'bot:status', status: 'joining', message: `Bot reconnecting (${reconnectAttempts}/${MAX_RECONNECTS})...` });
                try {
                  const rejoinRes = await fetch(`${botEndpoint}/join`, {
                    method: 'POST',
                    headers: botHeaders(),
                    body: JSON.stringify(config),
                    signal: AbortSignal.timeout(30_000),
                  });
                  if (rejoinRes.ok) {
                    log.log(`[bot] Auto-rejoin sent successfully`);
                  } else {
                    log.warn(`[bot] Auto-rejoin failed: HTTP ${rejoinRes.status}`);
                  }
                } catch (e) {
                  log.warn(`[bot] Auto-rejoin error: ${e instanceof Error ? e.message : e}`);
                }
              } else if (data.status === 'idle' && wasInMeeting && reconnectAttempts >= MAX_RECONNECTS) {
                log.log(`[bot] Bot left meeting after ${MAX_RECONNECTS} reconnect attempts — giving up`);
                broadcastWs({ type: 'bot:status', status: 'ended', message: 'Bot disconnected from meeting' });
                setBotState({ status: 'ready', message: 'Bot disconnected — pod still running' });
                scheduleBotIdleShutdown();
                break;
              }
            }
          } catch {
            consecutiveProbeFailures++;
            if (consecutiveProbeFailures >= MAX_PROBE_FAILURES) {
              log.warn(`[bot] Machine unreachable for ${consecutiveProbeFailures} consecutive probes — declaring crashed`);
              broadcastWs({ type: 'bot:status', status: 'ended', message: 'Bot machine crashed' });
              setBotState({ status: 'idle', message: 'Bot machine crashed — redeploy to reconnect' });
              scheduleBotIdleShutdown();
              break;
            }
          }
        }
      })().catch(() => {});

      if (deployState.status === 'ready' && deployState.endpoint) {
        warmupAllGpuModels(deployState.endpoint).catch(err =>
          log.warn('[warmup] Predictive warmup failed:', err instanceof Error ? err.message : err)
        );
      }

      const { startParecCapture } = await import('../../ws-server');
      if (isLocalBot) {
        startParecCapture();
      } else {
        startBotAudioPull(botEndpoint);
      }
    }
  } catch (err) {
    log.warn(`[bot] Failed to POST /join: ${err}`);
    setBotState({ status: 'ready', message: 'Bot /join error — pod still running' });
  }

  if (streamKey && botState.sshHost && botState.sshPort) {
    if (!/^[\w\-]{1,128}$/.test(streamKey)) {
      log.warn(`[bot] Rejected invalid YouTube stream key format`);
    } else {
      const sshHostBlocked = /^localhost$/i.test(botState.sshHost) || /^127\./.test(botState.sshHost) ||
        /^10\./.test(botState.sshHost) || /^192\.168\./.test(botState.sshHost) ||
        /^169\.254\./.test(botState.sshHost) || /^172\.(1[6-9]|2\d|3[01])\./.test(botState.sshHost);
      if (sshHostBlocked) {
        log.warn(`[bot] Blocked SSH to private IP: ${botState.sshHost}`);
      } else {
        try {
          const sshArgs = [
            'ssh',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=10',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-p', String(botState.sshPort),
            `root@${botState.sshHost}`,
            `STREAM_KEY='${streamKey}' nohup /app/start_youtube_stream.sh > /var/log/youtube_stream.log 2>&1 &`,
          ];
          const proc = Bun.spawn(sshArgs, { stdout: 'pipe', stderr: 'pipe' });
          setTimeout(async () => {
            try { proc.kill(); } catch { /* ignore */ }
          }, 30_000);
          proc.exited.then(code => {
            if (code !== 0) log.warn(`[bot] YouTube stream SSH launch exited with code ${code}`);
          }).catch(err => {
            log.warn(`[bot] YouTube stream SSH launch warning: ${err}`);
          });
          log.log(`[bot] YouTube stream started with key ${maskKey(streamKey)}`);
        } catch (err) {
          log.warn(`[bot] Failed to launch YouTube stream via SSH: ${err}`);
        }
      }
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    botId: botUuid,
    meetingUrl,
    streamingOutput,
    webcamRtmpUrl: botState.webcamRtmpUrl,
    config,
  }));
}

export async function handleBotLeave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!botState.endpoint || (botState.status !== 'joined' && botState.status !== 'ready')) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Bot not in a meeting (status: ${botState.status})` }));
    return;
  }

  try {
    const stopRes = await fetch(`${botState.endpoint}/stop_record`, {
      method: 'POST',
      headers: botHeaders(),
      body: JSON.stringify({ meeting_url: botState.meetingUrl }),
      signal: AbortSignal.timeout(10_000),
    });
    const ct = stopRes.headers.get('content-type') ?? '';
    const data = ct.includes('application/json')
      ? await stopRes.json().catch(() => ({}))
      : {};
    stopBotTranscriptPoll();
    broadcastWs({ type: 'bot:status', status: 'idle', message: 'Bot left meeting' });
    setBotState({ status: 'ready', message: 'Bot left meeting', meetingUrl: '', botId: '' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...data as Record<string, unknown> }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[bot] Leave failed: ${msg}`);
    stopBotTranscriptPoll();
    setBotState({ status: 'ready', message: 'Bot leave errored — state reset', meetingUrl: '', botId: '' });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to stop bot: ${msg}` }));
  }
}
