/**
 * Config routes — provider settings, API keys, profiles, labs
 *
 * Routes (currently registered in ws-server.ts):
 *   GET  /v1/config/providers         — Get provider configuration
 *   POST /v1/config/providers         — Update provider configuration
 *   GET  /v1/config/api-keys          — Get configured API keys (masked)
 *   POST /v1/config/api-keys          — Set API keys
 *   POST /v1/config/profiles          — Create profile
 *   DELETE /v1/config/profiles        — Delete profile
 *   POST /v1/config/profiles/activate — Activate profile
 *   GET  /v1/config/labs              — Get labs feature flags
 *   POST /v1/config/labs              — Update labs feature flags
 *
 * TODO: These routes are currently defined in ws-server.ts.
 * This file will own their registration once ws-server.ts is refactored.
 */

export const routes = {};
