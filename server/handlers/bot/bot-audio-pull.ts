/**
 * Bot Audio Pull — WebSocket audio relay from cloud bot
 */

import { flyio } from '../../providers';
import { wsClients } from '../../ws-state';
import { botPodApiKey } from '../../state';
import {
  log, botState, getBotAudioPullWs, setBotAudioPullWs,
} from './bot-shared';

export function startBotAudioPull(botEndpoint: string) {
  stopBotAudioPull();
  const flyHost = flyio.getFlyHost();
  const appName = process.env.BOT_FLY_APP_NAME || 'babelcast-bot';
  const baseUrl = flyHost ? `wss://${flyHost}` : `wss://${appName}.fly.dev`;
  const wsUrl = baseUrl + '/ws/audio-out';
  log.log(`[bot-audio-pull] Connecting to ${wsUrl}`);
  import('ws').then(({ WebSocket }) => {
    const headers: Record<string, string> = {};
    if (botPodApiKey) headers['Authorization'] = `Bearer ${botPodApiKey}`;
    const flyHost2 = flyio.getFlyHost();
    if (flyHost2) headers['Host'] = flyHost2;
    if (botState.podId && botState.podId !== 'local') headers['fly-force-instance-id'] = botState.podId;

    const ws = new WebSocket(wsUrl, { headers, handshakeTimeout: 15_000 });
    setBotAudioPullWs(ws);
    let chunks = 0;
    ws.on('open', () => log.log('[bot-audio-pull] Connected — receiving audio'));
    ws.on('message', (data) => {
      chunks++;
      if (chunks === 1 || chunks % 5000 === 0) {
        log.log(`[bot-audio-pull] chunk #${chunks} → ${wsClients.size} client(s)`);
      }
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const dead: typeof wsClients extends Set<infer T> ? T[] : never[] = [];
      for (const client of wsClients) {
        try { client.send(buf); } catch { dead.push(client); }
      }
      for (const c of dead) wsClients.delete(c);
    });
    ws.on('close', () => {
      log.log(`[bot-audio-pull] Disconnected (${chunks} chunks received)`);
      setBotAudioPullWs(null);
      if (botState.status === 'joined') {
        setTimeout(() => startBotAudioPull(botEndpoint), 5000);
      }
    });
    ws.on('error', (err) => {
      log.warn(`[bot-audio-pull] Error: ${err.message}`);
    });
  });
}

export function stopBotAudioPull() {
  const ws = getBotAudioPullWs();
  if (ws) {
    try { ws.close(); } catch { /* best-effort: cleanup */ }
    setBotAudioPullWs(null);
  }
}
