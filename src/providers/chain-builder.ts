/**
 * Pure functions for building provider fallback chains and resolving API keys.
 * Extracted from the app-level get-user-provider.ts — no DB or framework deps.
 */

import { ProviderClassification } from './classification';
import type { ProviderId } from './types';
import type { FallbackEntry } from './fallback';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SavedProfile {
  pipelineMode: 'omni' | 'pipeline';
  provider?: string;
  stt?: { provider: string; model: string };
  llm?: { provider: string; model: string };
  tts?: { provider: string; model: string };
  image?: { provider: string; model: string };
}

export interface PipelineStageConfig {
  provider: string;
  model: string;
}

export interface UserProviderSettings {
  activeProvider: ProviderId;
  endpoint?: string;
  keys: Record<string, string>;
  openai?: { sttModel?: string; ttsModel?: string; ttsVoice?: string };
  profiles?: SavedProfile[];
  pipelineStages?: {
    stt?: PipelineStageConfig;
    llm?: PipelineStageConfig;
    tts?: PipelineStageConfig;
    image?: PipelineStageConfig;
  };
  systemLlm?: { provider: string; model: string };
  systemStt?: { provider: string; model: string };
}

// ---------------------------------------------------------------------------
// API Key Resolution
// ---------------------------------------------------------------------------

/** Default env var mapping per provider */
const ENV_KEY_MAP: Partial<Record<ProviderId, string>> = {
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  'vast-serverless': 'VAST_API_KEY',
};

/**
 * Resolve the API key for a provider.
 * Checks user's saved key first, then falls back to environment variable.
 */
export function resolveApiKey(
  providerId: ProviderId,
  userKeys?: Record<string, string>,
): string | null {
  const userKey = userKeys?.[providerId];
  if (userKey) return userKey;

  const envVarName = ENV_KEY_MAP[providerId];
  return envVarName ? (process.env[envVarName] || null) : null;
}

// ---------------------------------------------------------------------------
// Fallback Chain Building
// ---------------------------------------------------------------------------

/**
 * Pure function: builds an ordered fallback chain from already-loaded settings.
 *
 * Priority order:
 *   1. Explicit profiles array (drag-and-drop order from Settings UI)
 *   2. pipelineStages (current active pipeline config)
 *   3. activeProvider as last resort
 */
export function buildFallbackChain(
  settings: UserProviderSettings | null,
  stage: 'stt' | 'llm' | 'tts' | 'image',
): FallbackEntry[] {
  const profiles: SavedProfile[] = settings?.profiles ?? [];
  const chain: FallbackEntry[] = [];
  const seen = new Set<string>();

  const addEntry = (provider: string, model?: string) => {
    if (!ProviderClassification.isCloud(provider) && provider !== 'vast-serverless') return;
    const key = `${provider}::${model ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      chain.push({ provider, model });
    }
  };

  // 1. Profiles (ordered by drag-and-drop priority in Settings)
  for (const profile of profiles) {
    if (profile.pipelineMode !== 'pipeline') continue;
    const stageCfg = profile[stage];
    if (!stageCfg?.provider) continue;
    addEntry(stageCfg.provider, stageCfg.model);
  }

  // 2. pipelineStages
  if (chain.length === 0) {
    const stageCfg = settings?.pipelineStages?.[stage];
    if (stageCfg?.provider) {
      addEntry(stageCfg.provider, stageCfg.model);
    }
  }

  // 3. Last resort: activeProvider
  if (chain.length === 0) {
    const fallback = settings?.activeProvider;
    chain.push({
      provider: fallback && (ProviderClassification.isCloud(fallback) || fallback === 'vast-serverless') ? fallback : 'openai',
    });
  }

  return chain;
}

/**
 * Get the system LLM entry from already-loaded settings (pure, no DB).
 * Falls back to first LLM entry in the user's profile chain.
 */
export function getSystemLlmEntryFromSettings(settings: UserProviderSettings | null): FallbackEntry {
  if (settings?.systemLlm?.provider && (ProviderClassification.isCloud(settings.systemLlm.provider) || settings.systemLlm.provider === 'vast-serverless')) {
    return { provider: settings.systemLlm.provider, model: settings.systemLlm.model };
  }
  const chain = buildFallbackChain(settings, 'llm');
  return chain[0];
}

/**
 * Get the system STT entry from already-loaded settings (pure, no DB).
 */
export function getSystemSttEntryFromSettings(settings: UserProviderSettings | null): FallbackEntry {
  if (settings?.systemStt?.provider && (ProviderClassification.isCloud(settings.systemStt.provider) || settings.systemStt.provider === 'vast-serverless')) {
    return { provider: settings.systemStt.provider, model: settings.systemStt.model };
  }
  const chain = buildFallbackChain(settings, 'stt');
  return chain[0];
}
