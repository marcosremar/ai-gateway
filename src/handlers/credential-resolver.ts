import type { SettingsStore } from '../deps';
import type { ProviderCredentials } from '../gpu-providers/types';

/** Maps provider id to the settings key under the `skypilot` namespace */
export const PROVIDER_KEY_MAP: Record<string, { apiKeyField: string; authIdField?: string }> = {
  tensordock: { apiKeyField: 'tensordockApiKey', authIdField: 'tensordockAuthId' },
  runpod: { apiKeyField: 'runpodApiKey' },
  vast: { apiKeyField: 'vastApiKey' },
  modal: { apiKeyField: 'modalApiKey' },
};

/** Maps provider id to the env var(s) to fall back to */
export const PROVIDER_ENV_MAP: Record<string, { apiKeyEnv: string; authIdEnv?: string }> = {
  tensordock: { apiKeyEnv: 'TENSORDOCK_API_KEY', authIdEnv: 'TENSORDOCK_AUTH_ID' },
  runpod: { apiKeyEnv: 'RUNPOD_API_KEY' },
  vast: { apiKeyEnv: 'VAST_API_KEY' },
  modal: { apiKeyEnv: 'MODAL_API_KEY' },
};

export function createCredentialResolver(settingsStore: SettingsStore) {
  return {
    async resolve(userId: string, provider: string): Promise<ProviderCredentials | null> {
      const keyMap = PROVIDER_KEY_MAP[provider];
      const envMap = PROVIDER_ENV_MAP[provider];

      if (!keyMap && !envMap) return null;

      let apiKey: string | undefined;
      let authId: string | undefined;
      let hfToken: string | undefined;

      // Try settings first
      try {
        const settings = await settingsStore.get(userId);
        const skypilot = (settings?.skypilot ?? {}) as Record<string, unknown>;

        if (keyMap) {
          apiKey = skypilot[keyMap.apiKeyField] as string | undefined;
          if (keyMap.authIdField) {
            authId = skypilot[keyMap.authIdField] as string | undefined;
          }
        }
        hfToken = skypilot['hfToken'] as string | undefined;
      } catch {
        // Fall through to env vars
      }

      // Fall back to env vars
      if (!apiKey && envMap) {
        apiKey = process.env[envMap.apiKeyEnv] ?? undefined;
        if (envMap.authIdEnv && !authId) {
          authId = process.env[envMap.authIdEnv] ?? undefined;
        }
      }

      if (!hfToken) {
        hfToken = process.env['HF_TOKEN'] ?? undefined;
      }

      if (!apiKey) return null;

      return { apiKey, authId, hfToken };
    },
  };
}
