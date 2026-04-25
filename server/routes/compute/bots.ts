/**
 * Bot routes — meeting bot lifecycle (Recall.ai + local Docker bots)
 *
 * Routes:
 *   POST /v1/bot/deploy              — Deploy meeting bot
 *   GET  /v1/bot/status              — Bot status
 *   POST /v1/bot/join                — Join meeting
 *   POST /v1/bot/leave               — Leave meeting
 *   POST /v1/bot/terminate           — Terminate bot
 *   POST /v1/bot/stream-page         — Stream a web page into the meeting
 *   POST /v1/bot/stop-stream         — Stop page streaming
 *   GET  /v1/bot/stream-status       — Page streaming status
 *
 * Note: Recall.ai WebSocket (/recall/audio) is handled by ws-server.ts
 * WebSocket handler, not as an HTTP route.
 */

export function registerBotRoutes(handlers: Record<string, Function>): void {
  const bh = require('../../bot-handlers');
  const ah = require('../../avatar-handlers');

  Object.assign(handlers, {
    'POST /v1/bot/deploy': bh.handleBotDeploy,
    'GET /v1/bot/status': bh.handleBotStatus,
    'POST /v1/bot/join': bh.handleBotJoin,
    'POST /v1/bot/leave': bh.handleBotLeave,
    'POST /v1/bot/terminate': bh.handleBotTerminate,
    'POST /v1/bot/stream-page': bh.handleBotStreamPage,
    'POST /v1/bot/stop-stream': bh.handleBotStopStream,
    'GET /v1/bot/stream-status': bh.handleBotStreamStatus,
    'POST /v1/bot/avatar/speak': ah.handleAvatarSpeak,
    'POST /v1/bot/avatar/animate-word': ah.handleAvatarAnimateWord,
    'POST /v1/bot/avatar/mood': ah.handleAvatarMood,
    'GET /v1/bot/avatar/status': ah.handleAvatarStatus,
  });
}
