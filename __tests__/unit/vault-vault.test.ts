import { describe, it, expect } from 'vitest';
import { Vault } from '../../src/vault/vault';
import type { VaultStore } from '../../src/vault/types';

const MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createStore(): VaultStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (name: string) => data.get(name) ?? null,
    set: async (name: string, val: string) => { data.set(name, val); },
    delete: async (name: string) => { data.delete(name); },
    list: async () => Array.from(data.keys()),
  };
}

describe('Vault', () => {
  it('encrypt returns blob with iv, ciphertext, tag, version', () => {
    const store = createStore();
    const vault = new Vault(MASTER_KEY, store);
    const blob = vault.encrypt('hello');
    expect(blob.iv).toBeDefined();
    expect(blob.ciphertext).toBeDefined();
    expect(blob.tag).toBeDefined();
    expect(blob.version).toBe(1);
  });

  it('decrypt reverses encrypt', () => {
    const store = createStore();
    const vault = new Vault(MASTER_KEY, store);
    const blob = vault.encrypt('secret value');
    expect(vault.decrypt(blob)).toBe('secret value');
  });

  it('storeSecret + retrieve round-trip', async () => {
    const store = createStore();
    const vault = new Vault(MASTER_KEY, store);
    await vault.storeSecret('api-key', 'sk-abc123');
    const value = await vault.retrieve('api-key');
    expect(value).toBe('sk-abc123');
  });

  it('retrieve throws for missing secret', async () => {
    const store = createStore();
    const vault = new Vault(MASTER_KEY, store);
    await expect(vault.retrieve('nonexistent')).rejects.toThrow('Secret "nonexistent" not found');
  });

  it('delete removes secret', async () => {
    const store = createStore();
    const vault = new Vault(MASTER_KEY, store);
    await vault.storeSecret('temp', 'value');
    await vault.delete('temp');
    await expect(vault.retrieve('temp')).rejects.toThrow('not found');
  });

  it('list returns secret names', async () => {
    const store = createStore();
    const vault = new Vault(MASTER_KEY, store);
    await vault.storeSecret('a', '1');
    await vault.storeSecret('b', '2');
    const names = await vault.list();
    expect(names.sort()).toEqual(['a', 'b']);
  });

  it('rotateKey re-encrypts with new key', async () => {
    const store = createStore();
    const vault = new Vault(MASTER_KEY, store);
    await vault.storeSecret('test', 'my-secret');
    const newKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    await vault.rotateKey(newKey);
    const value = await vault.retrieve('test');
    expect(value).toBe('my-secret');
  });

  it('should throw for invalid key length', () => {
    const store = createStore();
    expect(() => new Vault('short-key', store)).toThrow('masterKey must be 32 bytes');
  });
});
