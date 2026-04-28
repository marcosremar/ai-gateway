/**
 * Regression test: vault.rotateKey() must handle partial rotation failure
 * by ensuring the vault key and version remain consistent with the stored data.
 *
 * Bug: If rotateKey() re-encrypts secret A with the new key (write succeeds)
 * but fails to write secret B, the vault is left in an inconsistent state:
 *   - this.key is still the OLD key (correct -- not updated yet)
 *   - this.keyVersion is still the OLD version (correct)
 *   - Secret A in the store is encrypted with the NEW key
 *   - Secret B in the store is encrypted with the OLD key
 *   - retrieve(A) will FAIL: tries old key on new-key ciphertext
 *
 * The fix should ensure that after a failed rotation, all secrets remain
 * decryptable with the current (old) key.
 */

import { describe, it, expect } from 'vitest';
import { Vault } from '../../src/auth/vault';
import type { VaultStore } from '../../src/auth/vault/types';

const OLD_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const NEW_KEY = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

function createStoreWithFailOnSecondWrite(): VaultStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  let writeCount = 0;
  let rotationStarted = false;
  return {
    data,
    get: async (name: string) => data.get(name) ?? null,
    set: async (name: string, val: string) => {
      // Detect rotation: after initial stores, list() returns 2 entries,
      // and the rotation sets both again. Fail on the second rotation write.
      // We detect rotation by checking if the entry already exists.
      const isReEncrypt = data.has(name);
      if (isReEncrypt) {
        writeCount++;
        if (writeCount === 2) throw new Error('Simulated store write failure');
      }
      data.set(name, val);
    },
    delete: async (name: string) => { data.delete(name); },
    list: async () => Array.from(data.keys()),
  };
}

describe('Vault rotateKey partial failure', () => {
  it('should keep secrets decryptable after partial rotation failure', async () => {
    const store = createStoreWithFailOnSecondWrite();
    const vault = new Vault(OLD_KEY, store);

    // Store two secrets
    await vault.storeSecret('secret-a', 'value-a');
    await vault.storeSecret('secret-b', 'value-b');

    // Attempt rotation -- fails on the second secret
    await expect(vault.rotateKey(NEW_KEY)).rejects.toThrow('Simulated store write failure');

    // After the failed rotation, both secrets must still be decryptable
    // with the OLD key (this.key should still be OLD_KEY).
    const valueA = await vault.retrieve('secret-a');
    expect(valueA).toBe('value-a');

    const valueB = await vault.retrieve('secret-b');
    expect(valueB).toBe('value-b');
  });

  it('should allow successful rotation when all writes succeed', async () => {
    const data = new Map<string, string>();
    const store: VaultStore = {
      get: async (name: string) => data.get(name) ?? null,
      set: async (name: string, val: string) => { data.set(name, val); },
      delete: async (name: string) => { data.delete(name); },
      list: async () => Array.from(data.keys()),
    };
    const vault = new Vault(OLD_KEY, store);

    await vault.storeSecret('secret-a', 'value-a');
    await vault.storeSecret('secret-b', 'value-b');

    await vault.rotateKey(NEW_KEY);

    const valueA = await vault.retrieve('secret-a');
    expect(valueA).toBe('value-a');

    const valueB = await vault.retrieve('secret-b');
    expect(valueB).toBe('value-b');
  });
});
