/**
 * Tests for handlers/credential-resolver.ts
 * - createCredentialResolver()
 */

import { describe, it, expect, vi } from 'vitest';
import { createCredentialResolver } from '../src/handlers/credential-resolver';
import type { Vault } from '../src/vault/vault';

function makeVault(secrets: Record<string, string | Error> = {}): Vault {
  return {
    retrieve: vi.fn(async (name: string) => {
      const val = secrets[name];
      if (val instanceof Error) throw val;
      return val ?? null;
    }),
    storeSecret: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    encrypt: vi.fn(),
    decrypt: vi.fn(),
  } as unknown as Vault;
}

describe('createCredentialResolver', () => {
  it('resolves credentials from vault', async () => {
    const vault = makeVault({ 'runpod:apiKey': 'rp-key' });
    const resolver = createCredentialResolver(vault);
    const creds = await resolver.resolve('user-1', 'runpod');
    expect(creds).not.toBeNull();
    expect(creds!.apiKey).toBe('rp-key');
  });

  it('resolves credentials with authId and hfToken', async () => {
    const vault = makeVault({
      'tensordock:apiKey': 'td-key',
      'tensordock:authId': 'td-auth',
      hfToken: 'hf-token',
    });
    const resolver = createCredentialResolver(vault);
    const creds = await resolver.resolve('user-1', 'tensordock');
    expect(creds!.apiKey).toBe('td-key');
    expect(creds!.authId).toBe('td-auth');
    expect(creds!.hfToken).toBe('hf-token');
  });

  it('returns null when vault has no key for provider', async () => {
    const vault = makeVault({});
    const resolver = createCredentialResolver(vault);
    const creds = await resolver.resolve('user-1', 'runpod');
    expect(creds).toBeNull();
  });

  it('returns null when vault retrieve throws', async () => {
    const vault = makeVault({ 'runpod:apiKey': new Error('vault error') });
    const resolver = createCredentialResolver(vault);
    const creds = await resolver.resolve('user-1', 'runpod');
    expect(creds).toBeNull();
  });

  it('continues when authId retrieval fails but apiKey succeeds', async () => {
    const vault = makeVault({
      'runpod:apiKey': 'rp-key',
      'runpod:authId': new Error('no auth'),
    });
    const resolver = createCredentialResolver(vault);
    const creds = await resolver.resolve('user-1', 'runpod');
    expect(creds!.apiKey).toBe('rp-key');
    expect(creds!.authId).toBeUndefined();
  });

  it('continues when hfToken retrieval fails but apiKey succeeds', async () => {
    const vault = makeVault({
      'runpod:apiKey': 'rp-key',
      hfToken: new Error('no hf'),
    });
    const resolver = createCredentialResolver(vault);
    const creds = await resolver.resolve('user-1', 'runpod');
    expect(creds!.apiKey).toBe('rp-key');
    expect(creds!.hfToken).toBeUndefined();
  });

  it('returns null for unknown provider', async () => {
    const vault = makeVault({ 'runpod:apiKey': 'rp-key' });
    const resolver = createCredentialResolver(vault);
    const creds = await resolver.resolve('user-1', 'unknown-provider');
    expect(creds).toBeNull();
  });
});
