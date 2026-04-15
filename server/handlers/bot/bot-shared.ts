/**
 * Bot Handlers — Shared Constants, State, and Utilities
 */

import { createLogger } from '../../../src/logger';
import {
  botState, setBotStateVar, botPodApiKey,
} from '../../state';
import type { BotDeploymentState } from '../../state';
import { flyio } from '../../providers';

export const log = createLogger('bot-handlers');

export const BOT_POD_PREFIX = 'babelcast-bot-';
export const BOT_DOCKER_IMAGE = process.env.BOT_DOCKER_IMAGE || 'marcosremar/meet-teams-bot:latest';
export const BOT_PORTS = ['8080/http', '1936/tcp', '5900/http', '22/tcp', '3099/http'];
export const BOT_LOCAL_CONTAINER = 'babelcast-bot';
export const BOT_IDLE_SHUTDOWN_MS = 30 * 60_000;

let botAudioPullWs: import('ws').WebSocket | null = null;
export let botWatchdogGen = 0;
let botIdleTimer: Timer | null = null;

export function getBotAudioPullWs() { return botAudioPullWs; }
export function setBotAudioPullWs(ws: import('ws').WebSocket | null) { botAudioPullWs = ws; }
export function getBotWatchdogGen() { return botWatchdogGen; }
export function incrementBotWatchdogGen() { return ++botWatchdogGen; }
export function getBotIdleTimer() { return botIdleTimer; }
export function setBotIdleTimer(timer: Timer | null) { botIdleTimer = timer; }

export function redactMeetingUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/[redacted]`;
  } catch {
    return '[invalid-url]';
  }
}

export function botHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (botPodApiKey) h['Authorization'] = `Bearer ${botPodApiKey}`;
  if (botState.podId && botState.podId !== 'local' && (botState.endpoint?.includes('.fly.dev') || flyio.getFlyHost())) {
    h['fly-force-instance-id'] = botState.podId;
    const flyHost = flyio.getFlyHost();
    if (flyHost) h['Host'] = flyHost;
  }
  return h;
}

export function setBotState(patch: Partial<BotDeploymentState>) {
  Object.assign(botState, patch);
  log.log(`[bot] ${botState.status}: ${botState.message}`);
}

export { botState, setBotStateVar };
