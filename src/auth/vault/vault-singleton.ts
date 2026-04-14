import { Vault } from './vault';
import { FileVaultStore } from './file-store';
import type { VaultStore } from './types';

let vaultInstance: Vault | null = null;

export function initVaultFromEnv(): Vault | null {
  const masterKey = process.env.VAULT_MASTER_KEY;
  const vaultPath = process.env.VAULT_PATH;

  if (!masterKey || !vaultPath) {
    return null;
  }

  const store: VaultStore = new FileVaultStore(vaultPath);
  vaultInstance = new Vault(masterKey, store);
  return vaultInstance;
}

export function getVault(): Vault | null {
  return vaultInstance;
}

export function setVault(vault: Vault): void {
  vaultInstance = vault;
}

export function resetVault(): void {
  vaultInstance = null;
}
