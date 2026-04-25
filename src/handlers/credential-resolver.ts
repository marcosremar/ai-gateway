import type { SettingsStore } from '../deps';
import type { ProviderCredentials } from '../gpu-providers/types';

/** Minimal interface required — satisfied by the concrete Vault class and test mocks. */
export interface CredentialVault {
  retrieve(name: string): Promise<string | null>;
}

/** Maps provider id to the settings key under the `skypilot` namespace (settings-store path) */
export const PROVIDER_KEY_MAP: Record<string, { apiKeyField: string; authIdField?: string }> = {
  tensordock: { apiKeyField: 'tensordockApiKey', authIdField: 'tensordockAuthId' },
  runpod: { apiKeyField: 'runpodApiKey' },
  vast: { apiKeyField: 'vastApiKey' },
  hyperstack: { apiKeyField: 'hyperstackApiKey' },
  modal: { apiKeyField: 'modalApiKey' },
};

/** Maps provider id to the env var(s) to fall back to */
export const PROVIDER_ENV_MAP: Record<string, { apiKeyEnv: string; authIdEnv?: string }> = {
  tensordock: { apiKeyEnv: 'TENSORDOCK_API_KEY', authIdEnv: 'TENSORDOCK_AUTH_ID' },
  runpod: { apiKeyEnv: 'RUNPOD_API_KEY' },
  vast: { apiKeyEnv: 'VAST_API_KEY' },
  hyperstack: { apiKeyEnv: 'HYPERSTACK_API_KEY' },
  modal: { apiKeyEnv: 'MODAL_API_KEY' },
};

/** Known providers that have an authId field in the vault */
const VAULT_AUTH_ID_PROVIDERS = new Set(['tensordock']);

/**
 * Create a credential resolver backed by a Vault.
 * Secret names follow the convention: `"provider:apiKey"`, `"provider:authId"`, `"hfToken"`.
 */
export function createCredentialResolver(vault: CredentialVault): {
  resolve(userId: string, provider: string): Promise<ProviderCredentials | null>;
};

/**
 * Create a credential resolver backed by a SettingsStore (legacy path used by create-gateway.ts).
 * Falls back to environment variables when the store has no key.
 */
export function createCredentialResolver(settingsStore: SettingsStore): {
  resolve(userId: string, provider: string): Promise<ProviderCredentials | null>;
};

export function createCredentialResolver(store: CredentialVault | SettingsStore) {
  const isVault = typeof (store as CredentialVault).retrieve === 'function';

  if (isVault) {
    const vault = store as CredentialVault;
    return {
      async resolve(_userId: string, provider: string): Promise<ProviderCredentials | null> {
        let apiKey: string | undefined;
        let authId: string | undefined;
        let hfToken: string | undefined;

        try {
          apiKey = (await vault.retrieve(`${provider}:apiKey`)) ?? undefined;
        } catch {
          // vault error — treat as missing
        }

        if (!apiKey) {
          // Fall back to env vars
          const envMap = PROVIDER_ENV_MAP[provider];
          if (!envMap) return null;
          apiKey = process.env[envMap.apiKeyEnv] ?? undefined;
          if (!apiKey) return null;
          if (envMap.authIdEnv) authId = process.env[envMap.authIdEnv] ?? undefined;
        } else {
          if (VAULT_AUTH_ID_PROVIDERS.has(provider)) {
            try {
              authId = (await vault.retrieve(`${provider}:authId`)) ?? undefined;
            } catch {
              // optional — ignore
            }
          }
        }

        try {
          hfToken = (await vault.retrieve('hfToken')) ?? undefined;
        } catch (err) {
          // vault error — fall through to env var below
          console.warn('[credential-resolver] vault hfToken read failed:', err);
        }

        if (!hfToken) hfToken = process.env['HF_TOKEN'] ?? undefined;

        return { apiKey, authId, hfToken };
      },
    };
  }

  // ── SettingsStore path (legacy) ────────────────────────────────────────────
  const settingsStore = store as SettingsStore;
  return {
    async resolve(userId: string, provider: string): Promise<ProviderCredentials | null> {
      const keyMap = PROVIDER_KEY_MAP[provider];
      const envMap = PROVIDER_ENV_MAP[provider];

      if (!keyMap && !envMap) return null;

      let apiKey: string | undefined;
      let authId: string | undefined;
      let hfToken: string | undefined;

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
