import { ProviderClassification } from './classification';
import { getVault } from '../vault/vault-singleton';
import type { ProviderId } from './types';
import type { FallbackEntry } from './fallback';

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

const PROVIDER_ENV_KEYS: Partial<Record<ProviderId, string>> = {
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  modal: 'MODAL_API_KEY',
  ollama: '',
  gpu: '',
  'vast-serverless': '',
};

export async function resolveApiKey(providerId: ProviderId): Promise<string | null> {
  const vault = getVault();
  if (vault) {
    try {
      const key = await vault.retrieve(`${providerId}:apiKey`);
      if (key) return key;
    } catch {
      // fall through to env var
    }
  }
  const envKey = PROVIDER_ENV_KEYS[providerId];
  if (envKey === undefined) return null;
  return envKey ? (process.env[envKey] ?? null) : null;
}

export function buildFallbackChain(
  settings: UserProviderSettings | null,
  stage: 'stt' | 'llm' | 'tts' | 'image',
): FallbackEntry[] {
  const profiles: SavedProfile[] = settings?.profiles ?? [];
  const chain: FallbackEntry[] = [];
  const seen = new Set<string>();

  const addEntry = (provider: string, model?: string) => {
    if (!ProviderClassification.isCloud(provider) && !ProviderClassification.isLocal(provider) && provider !== 'vast-serverless') return;
    const key = `${provider}::${model ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      chain.push({ provider, model });
    }
  };

  for (const profile of profiles) {
    if (profile.pipelineMode !== 'pipeline') continue;
    const stageCfg = profile[stage];
    if (!stageCfg?.provider) continue;
    addEntry(stageCfg.provider, stageCfg.model);
  }

  if (chain.length === 0) {
    const stageCfg = settings?.pipelineStages?.[stage];
    if (stageCfg?.provider) {
      addEntry(stageCfg.provider, stageCfg.model);
    }
  }

  if (chain.length === 0) {
    const fallback = settings?.activeProvider;
    chain.push({
      provider: fallback && (ProviderClassification.isCloud(fallback) || fallback === 'vast-serverless') ? fallback : 'openai',
    });
  }

  return chain;
}

export function getSystemLlmEntryFromSettings(settings: UserProviderSettings | null): FallbackEntry {
  if (settings?.systemLlm?.provider && (ProviderClassification.isCloud(settings.systemLlm.provider) || settings.systemLlm.provider === 'vast-serverless')) {
    return { provider: settings.systemLlm.provider, model: settings.systemLlm.model };
  }
  const chain = buildFallbackChain(settings, 'llm');
  return chain[0];
}

export function getSystemSttEntryFromSettings(settings: UserProviderSettings | null): FallbackEntry {
  if (settings?.systemStt?.provider && (ProviderClassification.isCloud(settings.systemStt.provider) || settings.systemStt.provider === 'vast-serverless')) {
    return { provider: settings.systemStt.provider, model: settings.systemStt.model };
  }
  const chain = buildFallbackChain(settings, 'stt');
  return chain[0];
}
