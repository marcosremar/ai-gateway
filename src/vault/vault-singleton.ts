import { Vault } from './vault';
import { FileVaultStore } from './file-store';
import type { VaultStore } from './types';

let vaultInstance: Vault | null = null;

/** Accept exactly a 32-byte key as 64 hex chars or 44-char base64 — mirrors
 * `Vault.deriveKey`. Validating here makes a malformed key fail loudly at
 * startup instead of as a deferred throw on the first `new Vault(...)` /
 * encrypt call somewhere deep in request handling. */
export function isValidVaultMasterKey(masterKey: string): boolean {
  if (/^[0-9a-f]{64}$/i.test(masterKey)) return true;
  try {
    return Buffer.from(masterKey, 'base64').length === 32;
  } catch {
    return false;
  }
}

export function initVaultFromEnv(): Vault | null {
  const masterKey = process.env.VAULT_MASTER_KEY;
  const vaultPath = process.env.VAULT_PATH;

  if (!masterKey || !vaultPath) {
    return null;
  }

  if (!isValidVaultMasterKey(masterKey)) {
    throw new Error(
      '[Vault] VAULT_MASTER_KEY must be 32 bytes (64 hex chars or 44 base64 chars). ' +
        'Fix the value or unset VAULT_MASTER_KEY to disable the vault.',
    );
  }

  const store: VaultStore = new FileVaultStore(vaultPath);
  vaultInstance = new Vault(masterKey, store);
  return vaultInstance;
}

/**
 * Remove `VAULT_MASTER_KEY` from `process.env` after the vault has been
 * initialized (#647). Once `initVaultFromEnv()` has derived the key into the
 * `Vault` instance, leaving the raw key in the environment keeps it visible to
 * `/proc/self/environ`, any child process, and accidental env dumps for the
 * whole process lifetime. Call this right after a successful `initVaultFromEnv`.
 *
 * No-op if the vault isn't initialized yet — we never want to drop the key
 * before it's been consumed (that would silently disable the vault on a later
 * lazy init).
 *
 * @returns true if the key was present and removed.
 */
export function clearVaultMasterKeyFromEnv(): boolean {
  if (!vaultInstance) return false;
  if (process.env.VAULT_MASTER_KEY === undefined) return false;
  delete process.env.VAULT_MASTER_KEY;
  return true;
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
