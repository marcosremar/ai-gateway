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
import { logGpuEvent } from './metrics';
import { createLogger } from '../src/logger';

const log = createLogger('config-handlers');

import { validateInput } from '../src/input-validator';
import {
  ProviderConfigSchema,
  ApiKeysUpdateRequestSchema,
  ProfileRequestSchema,
  ProfileDeleteRequestSchema,
  ProfileActivateRequestSchema,
  LabsFlagsRequestSchema,
} from '../src/contracts';

/** Audit log for config changes — logs to console + persists to GPU event log */
function auditLog(action: string, requestId: string, details: Record<string, unknown>): void {
  const userId = details.userId || 'unknown';
  log.log(`${action} by=${userId} req=${requestId} ${JSON.stringify(details).slice(0, 200)}`);
  try { logGpuEvent(`config:${action}`, 'gateway', true, { metadata: { requestId, ...details } }); } catch { /* best-effort */ }
}
import { loadProviderConfig, patchProviderConfig, saveProviderConfig, applyAppLatencyTargets } from './config-persistence';
import type { PipelineChainEntry } from './config-persistence';
import { reloadStreamingSTTRouter } from './ws-server';
import type { GatewayApp, ProviderConfig } from './config-persistence';
import { reloadProviderAvailability, translationDefaults, updateActivePipeline } from './providers';
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
    const config = await loadProviderConfig();
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

  const validationResult = validateInput(body, ProviderConfigSchema);
  if (!validationResult.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Validation failed', details: validationResult.details }));
    return;
  }
  const validated = validationResult.data;

  try {
    const changedKeys = Object.keys(validated).filter(k => (validated as any)[k] !== undefined);
    auditLog('patch_config', requestId, { changedKeys, appCount: (validated as any).apps?.length });
    const updated = await patchProviderConfig(validated as Parameters<typeof patchProviderConfig>[0]);
    // Apply changed chains to runtime translationDefaults
    if (validated.pipelineStt && Array.isArray(validated.pipelineStt) && validated.pipelineStt.length > 0) {
      updateActivePipeline({ stt: validated.pipelineStt as unknown as PipelineChainEntry[] }, 'handlePatchProviderConfig:stt');
      await reloadStreamingSTTRouter();
    }
    if (validated.pipelineLlm && Array.isArray(validated.pipelineLlm) && validated.pipelineLlm.length > 0) {
      updateActivePipeline({ llm: validated.pipelineLlm as unknown as PipelineChainEntry[] }, 'handlePatchProviderConfig:llm');
    }
    if (validated.pipelineTts && Array.isArray(validated.pipelineTts) && validated.pipelineTts.length > 0) {
      updateActivePipeline({ tts: validated.pipelineTts as unknown as PipelineChainEntry[] }, 'handlePatchProviderConfig:tts');
    }
    // Broadcast config change to all connected WS clients (Python app, other dashboards)
    if (validated.activeAppId !== undefined || validated.pipelineStt || validated.pipelineLlm || validated.pipelineTts) {
      const activeApp = updated.apps?.find((p: any) => p.id === updated.activeAppId);
      broadcastWs({
        type: 'config:updated',
        activeAppId: updated.activeAppId,
        appName: activeApp?.name ?? null,
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

function escapeEnvValue(value: string): string {
  if (value.includes('\n') || value.includes('\r') || value.includes('"') || value.includes(' ') || value.includes('#')) {
    return `"${value.replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  }
  return value;
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

  const validationResult = validateInput(body, ApiKeysUpdateRequestSchema);
  if (!validationResult.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Validation failed', details: validationResult.details }));
    return;
  }
  const validated = validationResult.data;

  const updates = validated.keys;

  // Validate: only allow known env vars
  const validEnvVars = new Set(API_KEY_DEFS.map(d => d.envVar) as string[]);
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
  let saveFailed = false;
  try {
    const envPath = getEnvFilePath();
    let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

    for (const [envVar, value] of Object.entries(updates)) {
      if (typeof value !== 'string') continue;
      // Remove existing line for this var (escape envVar for regex safety)
      const escapedVar = envVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedVar}=.*$`, 'm');
      envContent = envContent.replace(regex, '').replace(/\n{3,}/g, '\n\n');

      // Add new line if value is non-empty (escape special chars)
      if (value) {
        envContent = envContent.trimEnd() + `\n${envVar}=${escapeEnvValue(value)}\n`;
      }
    }

    writeFileSync(envPath, envContent, { mode: 0o600 });
    // Belt-and-suspenders: writeFileSync mode only applies on file creation;
    // chmodSync enforces 0o600 on pre-existing files too.
    try { chmodSync(envPath, 0o600); } catch { /* best-effort: cleanup or optional side-effect */ }
  } catch (err) {
    log.error('Failed to persist API keys to .env:', err);
    saveFailed = true;
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

  res.writeHead(saveFailed ? 500 : 200, { 'Content-Type': 'application/json' });
  if (saveFailed) {
    res.end(JSON.stringify({ error: 'Failed to persist API keys to .env file' }));
    return;
  }
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

  const validationResult = validateInput(body, ProfileRequestSchema);
  if (!validationResult.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Validation failed', details: validationResult.details }));
    return;
  }
  const profileData = validationResult.data;

  const { id, name, stt, llm, tts, gpuDeploy, voice, audioFormat, temperature, maxTokens, language } = profileData;

  const config = await loadProviderConfig();
  const existing = config.apps.find(p => p.id === id);

  // Start from existing app (preserves services, latencyTargetsMs, loadBalanceStrategy,
  // timestamps, and all AIProfile fields). Then overlay only explicitly-sent fields.
  const base: Record<string, unknown> = existing ? { ...existing } : {};
  const app: GatewayApp = {
    ...base,
    id,
    name,
    stt: Array.isArray(stt) ? stt : (existing?.stt ?? config.pipelineStt),
    llm: Array.isArray(llm) ? llm : (existing?.llm ?? config.pipelineLlm),
    tts: Array.isArray(tts) ? tts : (existing?.tts ?? config.pipelineTts),
    ...(gpuDeploy !== undefined ? { gpuDeploy } : {}),
    ...(voice !== undefined ? { voice } : {}),
    ...(audioFormat !== undefined ? { audioFormat: audioFormat as GatewayApp['audioFormat'] } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(language !== undefined ? { language } : {}),
    // Preserve additional fields from request body (services, latencyTargetsMs, etc.)
    ...(body.services !== undefined ? { services: body.services } : {}),
    ...(body.latencyTargetsMs !== undefined ? { latencyTargetsMs: body.latencyTargetsMs } : {}),
    ...(body.loadBalanceStrategy !== undefined ? { loadBalanceStrategy: body.loadBalanceStrategy } : {}),
    ...(body.latency !== undefined ? { latency: body.latency } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
  } as GatewayApp;

  // Upsert: replace existing app with same id, or append
  const idx = config.apps.findIndex(p => p.id === id);
  if (idx >= 0) {
    config.apps[idx] = app;
  } else {
    config.apps.push(app);
  }

  await saveProviderConfig(config);
  log.log(`App ${idx >= 0 ? 'updated' : 'created'}: ${id} (${name})`);

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

  const validationResult = validateInput(body, ProfileDeleteRequestSchema);
  if (!validationResult.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Validation failed', details: validationResult.details }));
    return;
  }
  const { id } = validationResult.data;

  const config = await loadProviderConfig();
  const before = config.apps.length;
  config.apps = config.apps.filter(p => p.id !== id);

  if (config.apps.length === before) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `App not found: ${id}` }));
    return;
  }

  // If we deleted the active app, clear activeAppId
  if (config.activeAppId === id) {
    config.activeAppId = null;
  }

  await saveProviderConfig(config);
  log.log(`App deleted: ${id}`);

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

  const validationResult = validateInput(body, ProfileActivateRequestSchema);
  if (!validationResult.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Validation failed', details: validationResult.details }));
    return;
  }
  const { id } = validationResult.data;

  const config = await loadProviderConfig();

  // Allow deactivating by passing null/empty id
  if (!id) {
    config.activeAppId = null;
    await saveProviderConfig(config);
    log.log('App deactivated (no active app)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  const app = config.apps.find(p => p.id === id);
  if (!app) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `App not found: ${id}` }));
    return;
  }

  // Copy app chains to top-level pipeline fields (use copies to avoid mutating cached config)
  config.activeAppId = id;
  config.pipelineStt = [...(app.stt || [])] as unknown as PipelineChainEntry[];
  config.pipelineLlm = [...(app.llm || [])] as unknown as PipelineChainEntry[];
  config.pipelineTts = [...(app.tts || [])] as unknown as PipelineChainEntry[];

  // Apply app GPU deploy settings if present
  if (app.gpuDeploy) {
    if (app.gpuDeploy.dockerImage) setDeployDockerImage(app.gpuDeploy.dockerImage);
    if (app.gpuDeploy.region !== undefined) setDeployRegion(app.gpuDeploy.region);
    if (app.gpuDeploy.timeoutMin) setDeployTimeoutMin(app.gpuDeploy.timeoutMin);
    if (typeof app.gpuDeploy.raceCount === 'number') setDeployRaceCount(app.gpuDeploy.raceCount);
    log.log(`Applied gpuDeploy from app: image=${app.gpuDeploy.dockerImage}, region=${app.gpuDeploy.region}, timeout=${app.gpuDeploy.timeoutMin}min, race=${app.gpuDeploy.raceCount ?? 1}`);
  }

  await saveProviderConfig(config);
  applyAppLatencyTargets(id, config.apps);

  // ── Apply chains + extended fields to runtime translationDefaults ──
  const appPatch: Partial<AIProfile> = {
    stt: [...(app.stt ?? [])],
    llm: [...(app.llm ?? [])],
    tts: [...(app.tts ?? [])],
  };
  if (app.voice !== undefined) appPatch.voice = app.voice;
  if (app.audioFormat !== undefined) appPatch.audioFormat = app.audioFormat;
  if (app.temperature !== undefined) appPatch.temperature = app.temperature;
  if (app.maxTokens !== undefined) appPatch.maxTokens = app.maxTokens;
  if (app.language !== undefined) appPatch.language = app.language;
  updateActivePipeline(appPatch, `handleActivateApp:${id}`);

  // Rebuild streaming STT router for new STT chain
  await reloadStreamingSTTRouter();

  // ── Broadcast app activation to all WS clients (item #2) ──
  broadcastWs({
    type: 'app:activated',
    id,
    name: app.name,
    chains: {
      stt: app.stt,
      llm: app.llm,
      tts: app.tts,
    },
  });

  log.log(`App activated: ${id} (${app.name})`);

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

  const validationResult = validateInput(body, LabsFlagsRequestSchema);
  if (!validationResult.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Validation failed', details: validationResult.details }));
    return;
  }

  try {
    const updated = await setLabsFlags(validationResult.data as Parameters<typeof setLabsFlags>[0]);
    log.log(`Labs flags updated:`, JSON.stringify(updated));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

// ── User account stubs (local/desktop — no multi-user DB) ────────────────────

export async function handleGetUserAccounts(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ accounts: [] }));
}

export async function handleCreateUserAccount(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(501, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'User accounts not available in desktop mode' }));
}
