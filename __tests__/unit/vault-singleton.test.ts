import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initVaultFromEnv, getVault, setVault, resetVault } from '../../src/vault/vault-singleton';
import { Vault } from '../../src/vault/vault';
import { FileVaultStore } from '../../src/vault/file-store';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';

function createMemoryVaultStore(): import('../../src/vault/types').VaultStore {
  const store: Record<string, string> = {};
  return {
    get: async (name: string) => store[name] ?? null,
    set: async (name: string, value: string) => { store[name] = value; },
    delete: async (name: string) => { delete store[name]; },
    list: async () => Object.keys(store),
  };
}

const MASTER_KEY = 'a'.repeat(64);
let tempDir: string;

beforeEach(() => {
  resetVault();
  tempDir = join(os.tmpdir(), `vault-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  resetVault();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe('vault singleton', () => {
  it('getVault() without init → null', () => {
    expect(getVault()).toBeNull();
  });

  it('setVault(vault) + getVault() → returns same instance', () => {
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    setVault(vault);
    expect(getVault()).toBe(vault);
  });

  it('resetVault() → getVault returns null', () => {
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    setVault(vault);
    expect(getVault()).toBe(vault);
    resetVault();
    expect(getVault()).toBeNull();
  });
});

describe('initVaultFromEnv', () => {
  it('without VAULT_MASTER_KEY env → null', () => {
    const vaultPath = join(tempDir, 'vault.json');
    vi.stubEnv('VAULT_PATH', vaultPath);
    vi.stubEnv('VAULT_MASTER_KEY', '');
    const result = initVaultFromEnv();
    expect(result).toBeNull();
    vi.unstubAllEnvs();
  });

  it('without VAULT_PATH env → null', () => {
    vi.stubEnv('VAULT_MASTER_KEY', MASTER_KEY);
    vi.stubEnv('VAULT_PATH', '');
    const result = initVaultFromEnv();
    expect(result).toBeNull();
    vi.unstubAllEnvs();
  });

  it('with VAULT_MASTER_KEY + VAULT_PATH → returns Vault', () => {
    const vaultPath = join(tempDir, 'vault.json');
    vi.stubEnv('VAULT_MASTER_KEY', MASTER_KEY);
    vi.stubEnv('VAULT_PATH', vaultPath);
    const result = initVaultFromEnv();
    expect(result).toBeInstanceOf(Vault);
    expect(getVault()).toBe(result);
    vi.unstubAllEnvs();
  });
});
