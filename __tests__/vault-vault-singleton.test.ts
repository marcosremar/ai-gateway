import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initVaultFromEnv, getVault, setVault, resetVault } from '../src/vault/vault-singleton';
import { Vault } from '../src/vault/vault';

describe('vault-singleton', () => {
  const originalVaultKey = process.env.VAULT_MASTER_KEY;
  const originalVaultPath = process.env.VAULT_PATH;

  beforeEach(() => {
    resetVault();
    delete process.env.VAULT_MASTER_KEY;
    delete process.env.VAULT_PATH;
  });

  afterEach(() => {
    resetVault();
    if (originalVaultKey !== undefined) process.env.VAULT_MASTER_KEY = originalVaultKey;
    else delete process.env.VAULT_MASTER_KEY;
    if (originalVaultPath !== undefined) process.env.VAULT_PATH = originalVaultPath;
    else delete process.env.VAULT_PATH;
  });

  it('initVaultFromEnv returns null without env vars', () => {
    expect(initVaultFromEnv()).toBeNull();
  });

  it('getVault returns null initially', () => {
    expect(getVault()).toBeNull();
  });

  it('setVault sets the instance', () => {
    const store = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const vault = new Vault('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', store);
    setVault(vault);
    expect(getVault()).toBe(vault);
  });

  it('resetVault clears the instance', () => {
    const store = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const vault = new Vault('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', store);
    setVault(vault);
    expect(getVault()).toBe(vault);
    resetVault();
    expect(getVault()).toBeNull();
  });
});
