/**
 * Bot routes — meeting bot lifecycle (Recall.ai + local Docker bots)
 *
 * Routes (currently registered in ws-server.ts):
 *   POST /v1/bot/deploy              — Deploy meeting bot
 *   GET  /v1/bot/status              — Bot status
 *   POST /v1/bot/join                — Join meeting
 *   POST /v1/bot/leave               — Leave meeting
 *   POST /v1/bot/terminate           — Terminate bot
 *
 * Recall.ai WebSocket:
 *   WS   /recall/audio               — Recall bot audio stream
 *
 * TODO: These routes are currently defined in ws-server.ts.
 * This file will own their registration once ws-server.ts is refactored.
 */

export const routes = {};
