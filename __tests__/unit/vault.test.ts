import { describe, it, expect, beforeEach } from 'vitest';
import { Vault } from '../src/vault/vault';
import type { VaultStore } from '../src/vault/types';
import { randomBytes } from 'crypto';

/** Simple in-memory VaultStore for tests */
function createMemoryVaultStore(): VaultStore {
  const data = new Map<string, string>();
  return {
    get: async (name) => data.get(name) ?? null,
    set: async (name, val) => { data.set(name, val); },
    delete: async (name) => { data.delete(name); },
    list: async () => [...data.keys()],
  };
}

function randomHexKey(): string {
  return randomBytes(32).toString('hex');
}

describe('Vault', () => {
  let store: VaultStore;
  let masterKey: string;

  beforeEach(() => {
    store = createMemoryVaultStore();
    masterKey = randomHexKey();
  });

  it('encrypt/decrypt round-trip', () => {
    const vault = new Vault(masterKey, store);
    const plaintext = 'sk-my-secret-api-key-12345';
    const blob = vault.encrypt(plaintext);
    expect(blob.iv).toBeTruthy();
    expect(blob.ciphertext).toBeTruthy();
    expect(blob.tag).toBeTruthy();
    expect(blob.version).toBe(1);

    const decrypted = vault.decrypt(blob);
    expect(decrypted).toBe(plaintext);
  });

  it('store and retrieve secret', async () => {
    const vault = new Vault(masterKey, store);
    await vault.storeSecret('openai-key', 'sk-test-abc123');
    const retrieved = await vault.retrieve('openai-key');
    expect(retrieved).toBe('sk-test-abc123');
  });

  it('list secrets', async () => {
    const vault = new Vault(masterKey, store);
    await vault.storeSecret('key1', 'val1');
    await vault.storeSecret('key2', 'val2');
    const names = await vault.list();
    expect(names).toContain('key1');
    expect(names).toContain('key2');
    expect(names).toHaveLength(2);
  });

  it('delete secret', async () => {
    const vault = new Vault(masterKey, store);
    await vault.storeSecret('temp', 'val');
    await vault.delete('temp');
    await expect(vault.retrieve('temp')).rejects.toThrow('not found');
  });

  it('throws on missing secret', async () => {
    const vault = new Vault(masterKey, store);
    await expect(vault.retrieve('nonexistent')).rejects.toThrow('not found');
  });

  it('detects tampered ciphertext', () => {
    const vault = new Vault(masterKey, store);
    const blob = vault.encrypt('secret');
    // Tamper with ciphertext
    const tampered = { ...blob, ciphertext: 'ff'.repeat(blob.ciphertext.length / 2) };
    expect(() => vault.decrypt(tampered)).toThrow();
  });

  it('detects tampered auth tag', () => {
    const vault = new Vault(masterKey, store);
    const blob = vault.encrypt('secret');
    const tampered = { ...blob, tag: 'ff'.repeat(16) };
    expect(() => vault.decrypt(tampered)).toThrow();
  });

  it('wrong key cannot decrypt', () => {
    const vault1 = new Vault(masterKey, store);
    const vault2 = new Vault(randomHexKey(), store);
    const blob = vault1.encrypt('secret');
    expect(() => vault2.decrypt(blob)).toThrow();
  });

  it('key rotation re-encrypts all secrets', async () => {
    const vault = new Vault(masterKey, store);
    await vault.storeSecret('a', 'alpha');
    await vault.storeSecret('b', 'bravo');

    const newKey = randomHexKey();
    await vault.rotateKey(newKey);

    // After rotation, vault uses new key — should still retrieve
    expect(await vault.retrieve('a')).toBe('alpha');
    expect(await vault.retrieve('b')).toBe('bravo');

    // Old key can no longer decrypt
    const oldVault = new Vault(masterKey, store);
    await expect(oldVault.retrieve('a')).rejects.toThrow();
  });

  it('rejects invalid master key', () => {
    expect(() => new Vault('too-short', store)).toThrow('32 bytes');
  });

  it('accepts base64 master key', () => {
    const b64Key = randomBytes(32).toString('base64');
    const vault = new Vault(b64Key, store);
    const blob = vault.encrypt('test');
    expect(vault.decrypt(blob)).toBe('test');
  });
});
