// ── BabelCast Gateway — Config HTTP Handlers ────────────────────────────────
// handleGetProviderConfig, handlePatchProviderConfig, handleGetApiKeys, handleSetApiKeys
// handleCreateProfile, handleDeleteProfile, handleActivateProfile
// handleGetLabsFlags, handlePatchLabsFlags
// GET    /v1/config/providers          — load provider config
// POST   /v1/config/providers          — patch (merge) provider config
// GET    /v1/config/api-keys           — list configured API keys (masked)
// POST   /v1/config/api-keys           — update API keys in .env
// POST   /v1/config/profiles           — create or update a profile
// DELETE /v1/config/profiles           — delete a profile by id
// POST   /v1/config/profiles/activate  — activate a profile (copy chains to top-level)
// GET    /v1/config/labs               — get labs feature flags
// POST   /v1/config/labs               — patch labs feature flags

import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOrCreateRequestId, setRequestIdHeader, readJsonBody, handleBodyError } from './http-utils';
import { loadProviderConfig, patchProviderConfig, saveProviderConfig } from './config-persistence';
import type { PipelineChainEntry } from './config-persistence';
import { reloadStreamingSTTRouter } from './ws-server';
import type { GatewayProfile, ProviderConfig } from './config-persistence';
import { reloadProviderAvailability, translationProfile, updateTranslationProfile } from './providers';
import type { AIProfile } from '../src/client';
import { broadcastWs } from './ws-state';
import { setDeployTimeoutMin, setDeployRegion, setDeployDockerImage, setDeployRaceCount } from '../src/gpu-providers/deploy-settings';
import { getLabsFlags, setLabsFlags } from './labs-settings';
import { speculativeCache } from './speculative-cache';

/** GET /v1/config/providers — returns the full provider config */
export async function handleGetProviderConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const config = loadProviderConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

/** POST /v1/config/providers — patch provider config (merge partial update) */
export async function handlePatchProviderConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  // Validate arrays if provided
  for (const key of ['pipelineStt', 'pipelineLlm', 'pipelineTts'] as const) {
    if (body[key] !== undefined && !Array.isArray(body[key])) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `${key} must be an array` }));
      return;
    }
  }
  if (body.profiles !== undefined && !Array.isArray(body.profiles)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'profiles must be an array' }));
    return;
  }

  try {
    const updated = patchProviderConfig(body as Parameters<typeof patchProviderConfig>[0]);
    // Apply changed chains to runtime translationProfile
    if (body.pipelineStt && Array.isArray(body.pipelineStt) && body.pipelineStt.length > 0) {
      updateTranslationProfile({ stt: body.pipelineStt as PipelineChainEntry[] }, 'handlePatchProviderConfig:stt');
      reloadStreamingSTTRouter();
    }
    if (body.pipelineLlm && Array.isArray(body.pipelineLlm) && body.pipelineLlm.length > 0) {
      updateTranslationProfile({ llm: body.pipelineLlm as PipelineChainEntry[] }, 'handlePatchProviderConfig:llm');
    }
    if (body.pipelineTts && Array.isArray(body.pipelineTts) && body.pipelineTts.length > 0) {
      updateTranslationProfile({ tts: body.pipelineTts as PipelineChainEntry[] }, 'handlePatchProviderConfig:tts');
    }
    // Broadcast config change to all connected WS clients (Python app, other dashboards)
    if (body.activeProfileId !== undefined || body.pipelineStt || body.pipelineLlm || body.pipelineTts) {
      const activeProfile = updated.profiles?.find((p: any) => p.id === updated.activeProfileId);
      broadcastWs({
        type: 'config:updated',
        activeProfileId: updated.activeProfileId,
        profileName: activeProfile?.name ?? null,
        chains: {
          stt: updated.pipelineStt,
          llm: updated.pipelineLlm,
          tts: updated.pipelineTts,
        },
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

// ── API Keys ────────────────────────────────────────────────────────────────

const API_KEY_DEFS = [
  { envVar: 'GROQ_API_KEY', id: 'groq', name: 'Groq', category: 'cloud' },
  { envVar: 'OPENAI_API_KEY', id: 'openai', name: 'OpenAI', category: 'cloud' },
  { envVar: 'DEEPGRAM_API_KEY', id: 'deepgram', name: 'Deepgram', category: 'cloud' },
  { envVar: 'FIREWORKS_API_KEY', id: 'fireworks', name: 'Fireworks', category: 'cloud' },
  { envVar: 'OPENROUTER_API_KEY', id: 'openrouter', name: 'OpenRouter', category: 'cloud' },
  { envVar: 'VAST_API_KEY', id: 'vast', name: 'Vast.ai', category: 'gpu' },
  { envVar: 'TENSORDOCK_API_KEY', id: 'tensordock', name: 'TensorDock', category: 'gpu' },
  { envVar: 'TENSORDOCK_AUTH_ID', id: 'tensordock_auth', name: 'TensorDock Auth ID', category: 'gpu' },
  { envVar: 'RUNPOD_API_KEY', id: 'runpod', name: 'RunPod', category: 'gpu' },
] as const;

function maskKey(key: string): string {
  if (!key || key.length < 8) return key ? '***' : '';
  return key.substring(0, 3) + '***' + key.substring(key.length - 3);
}

function getEnvFilePath(): string {
  const __dir = dirname(fileURLToPath(import.meta.url));
  return resolve(__dir, '..', '.env');
}

/** GET /v1/config/api-keys — returns masked keys + configured status */
export async function handleGetApiKeys(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  const keys = API_KEY_DEFS.map(def => ({
    id: def.id,
    name: def.name,
    envVar: def.envVar,
    category: def.category,
    configured: !!process.env[def.envVar],
    masked: maskKey(process.env[def.envVar] || ''),
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ keys }));
}

/** POST /v1/config/api-keys — update keys in process.env and persist to .env file */
export async function handleSetApiKeys(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const updates = body.keys as Record<string, string> | undefined;
  if (!updates || typeof updates !== 'object') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'body.keys must be an object mapping envVar -> value' }));
    return;
  }

  // Validate: only allow known env vars
  const validEnvVars = new Set(API_KEY_DEFS.map(d => d.envVar));
  for (const key of Object.keys(updates)) {
    if (!validEnvVars.has(key)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown key: ${key}` }));
      return;
    }
  }

  // Update process.env
  for (const [envVar, value] of Object.entries(updates)) {
    if (typeof value === 'string') {
      if (value) {
        process.env[envVar] = value;
      } else {
        delete process.env[envVar];
      }
    }
  }

  // Persist to .env file
  try {
    const envPath = getEnvFilePath();
    let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

    for (const [envVar, value] of Object.entries(updates)) {
      if (typeof value !== 'string') continue;
      // Remove existing line for this var (escape envVar for regex safety)
      const escapedVar = envVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedVar}=.*$`, 'm');
      envContent = envContent.replace(regex, '').replace(/\n{3,}/g, '\n\n');

      // Add new line if value is non-empty
      if (value) {
        envContent = envContent.trimEnd() + `\n${envVar}=${value}\n`;
      }
    }

    writeFileSync(envPath, envContent, { mode: 0o600 });
    // Belt-and-suspenders: writeFileSync mode only applies on file creation;
    // chmodSync enforces 0o600 on pre-existing files too.
    try { chmodSync(envPath, 0o600); } catch {}
  } catch (err) {
    console.warn('[config] Failed to persist API keys to .env:', err);
  }

  // Reload provider availability flags so changes take effect without restart
  const providerChanges = reloadProviderAvailability();

  // Return updated status
  const keys = API_KEY_DEFS.map(def => ({
    id: def.id,
    name: def.name,
    envVar: def.envVar,
    category: def.category,
    configured: !!process.env[def.envVar],
    masked: maskKey(process.env[def.envVar] || ''),
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ keys, saved: true, providerChanges }));
}

// ── Profile CRUD ─────────────────────────────────────────────────────────────

/** POST /v1/config/profiles — create or update a provider profile */
export async function handleCreateProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const { id, name, stt, llm, tts, gpuDeploy, voice, audioFormat, temperature, maxTokens, language } = body as {
    id?: string; name?: string;
    stt?: GatewayProfile['stt']; llm?: GatewayProfile['llm']; tts?: GatewayProfile['tts'];
    gpuDeploy?: GatewayProfile['gpuDeploy'];
    voice?: string; audioFormat?: string; temperature?: number; maxTokens?: number; language?: string;
  };

  if (!id || typeof id !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'id is required and must be a string' }));
    return;
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid profile id. Use alphanumeric, dash, underscore. Max 64 chars.' }));
    return;
  }
  if (!name || typeof name !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'name is required and must be a string' }));
    return;
  }

  const config = loadProviderConfig();
  const existing = config.profiles.find(p => p.id === id);
  const profile: GatewayProfile = {
    id,
    name,
    stt: Array.isArray(stt) ? stt : (existing?.stt ?? config.pipelineStt),
    llm: Array.isArray(llm) ? llm : (existing?.llm ?? config.pipelineLlm),
    tts: Array.isArray(tts) ? tts : (existing?.tts ?? config.pipelineTts),
    ...(gpuDeploy !== undefined ? { gpuDeploy } : existing?.gpuDeploy ? { gpuDeploy: existing.gpuDeploy } : {}),
    // Extended AIProfile fields (backward-compatible: omitted = inherited from existing/default)
    ...(voice !== undefined ? { voice } : existing?.voice ? { voice: existing.voice } : {}),
    ...(audioFormat !== undefined ? { audioFormat: audioFormat as GatewayProfile['audioFormat'] } : existing?.audioFormat ? { audioFormat: existing.audioFormat } : {}),
    ...(temperature !== undefined ? { temperature } : existing?.temperature !== undefined ? { temperature: existing.temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : existing?.maxTokens !== undefined ? { maxTokens: existing.maxTokens } : {}),
    ...(language !== undefined ? { language } : existing?.language ? { language: existing.language } : {}),
  };

  // Upsert: replace existing profile with same id, or append
  const idx = config.profiles.findIndex(p => p.id === id);
  if (idx >= 0) {
    config.profiles[idx] = profile;
  } else {
    config.profiles.push(profile);
  }

  saveProviderConfig(config);
  console.log(`[config] Profile ${idx >= 0 ? 'updated' : 'created'}: ${id} (${name})`);

  res.writeHead(idx >= 0 ? 200 : 201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(config));
}

/** DELETE /v1/config/profiles — delete a provider profile by id */
export async function handleDeleteProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const { id } = body as { id?: string };
  if (!id || typeof id !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'id is required and must be a string' }));
    return;
  }

  const config = loadProviderConfig();
  const before = config.profiles.length;
  config.profiles = config.profiles.filter(p => p.id !== id);

  if (config.profiles.length === before) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Profile not found: ${id}` }));
    return;
  }

  // If we deleted the active profile, clear activeProfileId
  if (config.activeProfileId === id) {
    config.activeProfileId = null;
  }

  saveProviderConfig(config);
  console.log(`[config] Profile deleted: ${id}`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(config));
}

/** POST /v1/config/profiles/activate — activate a profile, copying its chains to top-level pipeline */
export async function handleActivateProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const { id } = body as { id?: string | null };

  const config = loadProviderConfig();

  // Allow deactivating by passing null/empty id
  if (!id) {
    config.activeProfileId = null;
    saveProviderConfig(config);
    console.log('[config] Profile deactivated (no active profile)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  const profile = config.profiles.find(p => p.id === id);
  if (!profile) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Profile not found: ${id}` }));
    return;
  }

  // Copy profile chains to top-level pipeline fields
  config.activeProfileId = id;
  config.pipelineStt = [...profile.stt];
  config.pipelineLlm = [...profile.llm];
  config.pipelineTts = [...profile.tts];

  // Apply profile GPU deploy settings if present
  if (profile.gpuDeploy) {
    if (profile.gpuDeploy.dockerImage) setDeployDockerImage(profile.gpuDeploy.dockerImage);
    if (profile.gpuDeploy.region !== undefined) setDeployRegion(profile.gpuDeploy.region);
    if (profile.gpuDeploy.timeoutMin) setDeployTimeoutMin(profile.gpuDeploy.timeoutMin);
    if (typeof profile.gpuDeploy.raceCount === 'number') setDeployRaceCount(profile.gpuDeploy.raceCount);
    console.log(`[config] Applied gpuDeploy from profile: image=${profile.gpuDeploy.dockerImage}, region=${profile.gpuDeploy.region}, timeout=${profile.gpuDeploy.timeoutMin}min, race=${profile.gpuDeploy.raceCount ?? 1}`);
  }

  saveProviderConfig(config);

  // ── Apply chains + extended fields to runtime translationProfile ──
  const profilePatch: Partial<AIProfile> = {
    stt: [...(profile.stt ?? [])],
    llm: [...(profile.llm ?? [])],
    tts: [...(profile.tts ?? [])],
  };
  if (profile.voice !== undefined) profilePatch.voice = profile.voice;
  if (profile.audioFormat !== undefined) profilePatch.audioFormat = profile.audioFormat;
  if (profile.temperature !== undefined) profilePatch.temperature = profile.temperature;
  if (profile.maxTokens !== undefined) profilePatch.maxTokens = profile.maxTokens;
  if (profile.language !== undefined) profilePatch.language = profile.language;
  updateTranslationProfile(profilePatch, `handleActivateProfile:${id}`);

  // Rebuild streaming STT router for new STT chain
  reloadStreamingSTTRouter();

  // ── Broadcast profile activation to all WS clients (item #2) ──
  broadcastWs({
    type: 'profile:activated',
    id,
    name: profile.name,
    chains: {
      stt: profile.stt,
      llm: profile.llm,
      tts: profile.tts,
    },
  });

  console.log(`[config] Profile activated: ${id} (${profile.name})`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(config));
}

// ── Labs Feature Flags ───────────────────────────────────────────────────────

/** GET /v1/config/labs — returns current labs feature flags + speculation stats */
export async function handleGetLabsFlags(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const flags = getLabsFlags();
    const speculationStats = speculativeCache.stats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...flags, speculationStats }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

/** POST /v1/config/labs — patch labs feature flags (merge partial update) */
export async function handlePatchLabsFlags(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  try {
    const updated = setLabsFlags(body as Parameters<typeof setLabsFlags>[0]);
    console.log(`[config] Labs flags updated:`, JSON.stringify(updated));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}
