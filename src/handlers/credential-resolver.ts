/**
 * Credential resolution logic — extracted from gpu-autoscaler route.
 *
 * Resolution order: Vault → User Settings (SettingsStore) → Environment Variables.
 */
import type { SettingsStore } from '../deps';
import type { Vault } from '../vault/vault';
import type { ProviderCredentials } from '../gpu-providers/types';

export const PROVIDER_KEY_MAP: Record<string, { keyField: string; authField?: string }> = {
  tensordock: { keyField: 'tensordockApiKey', authField: 'tensordockAuthId' },
  runpod:     { keyField: 'runpodApiKey' },
  vast:       { keyField: 'vastApiKey' },
  modal:      { keyField: 'modalApiKey' },
};

export const PROVIDER_ENV_MAP: Record<string, { keyEnv: string; authEnv?: string }> = {
  tensordock: { keyEnv: 'TENSORDOCK_API_KEY', authEnv: 'TENSORDOCK_AUTH_ID' },
  runpod:     { keyEnv: 'RUNPOD_API_KEY' },
  vast:       { keyEnv: 'VAST_API_KEY' },
  modal:      { keyEnv: 'MODAL_API_KEY' },
};

/**
 * Create a CredentialStore backed by a SettingsStore.
 * Resolution order: Vault → user settings (skypilot sub-object) → env vars.
 */
export function createCredentialResolver(settingsStore: SettingsStore, vault?: Vault) {
  return {
    async resolve(userId: string, provider: string): Promise<ProviderCredentials | null> {
      // 0. Try vault first
      if (vault) {
        try {
          const apiKey = await vault.retrieve(`${provider}:apiKey`);
          if (apiKey) {
            const authId = await vault.retrieve(`${provider}:authId`).catch(() => undefined);
            const hfToken = await vault.retrieve('hfToken').catch(() => undefined);
            return { apiKey, authId, hfToken };
          }
        } catch { /* not in vault, continue */ }
      }

      // 1. Try user settings (skypilot sub-object)
      try {
        const settings = await settingsStore.get(userId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const skypilot = settings.skypilot as Record<string, any> | undefined;
        const mapping = PROVIDER_KEY_MAP[provider];
        if (skypilot && mapping) {
          const apiKey = skypilot[mapping.keyField] as string | undefined;
          if (apiKey) {
            return {
              apiKey,
              authId: mapping.authField ? (skypilot[mapping.authField] as string | undefined) : undefined,
              hfToken: skypilot.hfToken as string | undefined,
            };
          }
        }
      } catch { /* settings not found */ }

      // 2. Fallback to env vars
      const envMapping = PROVIDER_ENV_MAP[provider];
      if (envMapping) {
        const apiKey = process.env[envMapping.keyEnv];
        if (apiKey) {
          return {
            apiKey,
            authId: envMapping.authEnv ? process.env[envMapping.authEnv] : undefined,
            hfToken: process.env.HF_TOKEN,
          };
        }
      }

      return null;
    },
  };
}
