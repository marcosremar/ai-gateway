/**
 * Pipeline routes — WebSocket-based real-time speech pipeline
 *
 * Routes (currently registered in ws-server.ts):
 *   WS /v1/speech/ws                 — Real-time speech-to-speech WebSocket
 *   WS /recall/audio                 — Recall.ai bot audio WebSocket
 *
 * TODO: These routes are currently defined in ws-server.ts.
 * This file will own their registration once ws-server.ts is refactored.
 */

export const routes = {};
