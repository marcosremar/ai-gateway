/**
 * Config routes — provider settings, API keys, profiles, labs
 *
 * Routes:
 *   GET  /v1/config/providers         — Get provider configuration
 *   POST /v1/config/providers         — Update provider configuration
 *   GET  /v1/config/api-keys          — Get configured API keys (masked)
 *   POST /v1/config/api-keys          — Set API keys
 *   POST /v1/config/profiles          — Create profile
 *   DELETE /v1/config/profiles        — Delete profile
 *   POST /v1/config/profiles/activate — Activate profile
 *   GET  /v1/config/labs              — Get labs feature flags
 *   POST /v1/config/labs              — Update labs feature flags
 */

export function registerConfigRoutes(handlers: Record<string, Function>): void {
  const ch = require('../../config-handlers');

  Object.assign(handlers, {
    'GET /v1/config/providers': ch.handleGetProviderConfig,
    'POST /v1/config/providers': ch.handlePatchProviderConfig,
    'GET /v1/config/api-keys': ch.handleGetApiKeys,
    'POST /v1/config/api-keys': ch.handleSetApiKeys,
    'POST /v1/config/profiles': ch.handleCreateProfile,
    'DELETE /v1/config/profiles': ch.handleDeleteProfile,
    'POST /v1/config/profiles/activate': ch.handleActivateProfile,
    'GET /v1/config/labs': ch.handleGetLabsFlags,
    'POST /v1/config/labs': ch.handlePatchLabsFlags,
  });
}
