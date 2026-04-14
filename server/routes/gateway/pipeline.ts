/**
 * Pipeline routes — WebSocket-based real-time speech pipeline
 *
 * Routes (still managed by ws-server.ts WebSocket handler):
 *   WS /v1/speech/ws                 — Real-time speech-to-speech WebSocket
 *   WS /v1/stt/stream                — Streaming STT WebSocket
 *   WS /ws/bot-audio                 — Bot audio relay WebSocket
 *   WS /recall/audio                 — Recall.ai bot audio WebSocket
 *
 * These routes are WebSocket upgrades and remain in ws-server.ts because they
 * require deep integration with the Bun.serve() websocket handler. This file
 * exists as a documentation placeholder in the route hierarchy.
 */

// No HTTP routes to register — all pipeline routes are WebSocket-based.
export function registerPipelineRoutes(_handlers: Record<string, Function>): void {
  // WebSocket routes are handled directly by ws-server.ts Bun.serve() websocket config.
}
