import type { Vault } from '../vault/vault';
import type { ProviderCredentials } from '../gpu-providers/types';

export function createCredentialResolver(vault: Vault) {
  return {
    async resolve(_userId: string, provider: string): Promise<ProviderCredentials | null> {
      try {
        const apiKey = await vault.retrieve(`${provider}:apiKey`);
        if (apiKey) {
          const authId = await vault.retrieve(`${provider}:authId`).catch(() => undefined);
          const hfToken = await vault.retrieve('hfToken').catch(() => undefined);
          return { apiKey, authId, hfToken };
        }
      } catch { /* not in vault */ }
      return null;
    },
  };
}
