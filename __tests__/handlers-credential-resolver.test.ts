/**
 * Tests for handlers/credential-resolver.ts
 * - PROVIDER_KEY_MAP
 * - PROVIDER_ENV_MAP
 * - createCredentialResolver()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PROVIDER_KEY_MAP,
  PROVIDER_ENV_MAP,
  createCredentialResolver,
} from '../src/handlers/credential-resolver';
import type { SettingsStore } from '../src/deps';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['TENSORDOCK_API_KEY', 'TENSORDOCK_AUTH_ID', 'RUNPOD_API_KEY', 'VAST_API_KEY', 'MODAL_API_KEY', 'HF_TOKEN']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function makeSettingsStore(settings: Record<string, unknown> = {}): SettingsStore {
  return {
    async get(_userId) { return settings; },
    async patch() {},
  };
}

describe('PROVIDER_KEY_MAP', () => {
  it('has tensordock with keyField and authField', () => {
    expect(PROVIDER_KEY_MAP.tensordock.keyField).toBe('tensordockApiKey');
    expect(PROVIDER_KEY_MAP.tensordock.authField).toBe('tensordockAuthId');
  });

  it('has runpod with keyField only', () => {
    expect(PROVIDER_KEY_MAP.runpod.keyField).toBe('runpodApiKey');
    expect(PROVIDER_KEY_MAP.runpod.authField).toBeUndefined();
  });

  it('has vast with keyField only', () => {
    expect(PROVIDER_KEY_MAP.vast.keyField).toBe('vastApiKey');
  });

  it('has modal with keyField only', () => {
    expect(PROVIDER_KEY_MAP.modal.keyField).toBe('modalApiKey');
  });
});

describe('PROVIDER_ENV_MAP', () => {
  it('has tensordock with keyEnv and authEnv', () => {
    expect(PROVIDER_ENV_MAP.tensordock.keyEnv).toBe('TENSORDOCK_API_KEY');
    expect(PROVIDER_ENV_MAP.tensordock.authEnv).toBe('TENSORDOCK_AUTH_ID');
  });

  it('has runpod with keyEnv only', () => {
    expect(PROVIDER_ENV_MAP.runpod.keyEnv).toBe('RUNPOD_API_KEY');
    expect(PROVIDER_ENV_MAP.runpod.authEnv).toBeUndefined();
  });

  it('has vast with keyEnv only', () => {
    expect(PROVIDER_ENV_MAP.vast.keyEnv).toBe('VAST_API_KEY');
  });

  it('has modal with keyEnv only', () => {
    expect(PROVIDER_ENV_MAP.modal.keyEnv).toBe('MODAL_API_KEY');
  });
});

describe('createCredentialResolver', () => {
  it('resolves credentials from user settings (skypilot)', async () => {
    const store = makeSettingsStore({
      skypilot: { runpodApiKey: 'rp-user-key' },
    });
    const resolver = createCredentialResolver(store);
    const creds = await resolver.resolve('user-1', 'runpod');
    expect(creds).not.toBeNull();
    expect(creds!.apiKey).toBe('rp-user-key');
  });

  it('resolves tensordock credentials with authId', async () => {
    const store = makeSettingsStore({
      skypilot: {
        tensordockApiKey: 'td-key',
        tensordockAuthId: 'td-auth',
        hfToken: 'hf-token',
      },
    });
    const resolver = createCredentialResolver(store);
    const creds = await resolver.resolve('user-1', 'tensordock');
    expect(creds!.apiKey).toBe('td-key');
    expect(creds!.authId).toBe('td-auth');
    expect(creds!.hfToken).toBe('hf-token');
  });

  it('falls back to env vars when settings missing key', async () => {
    const store = makeSettingsStore({ skypilot: {} });
    process.env.RUNPOD_API_KEY = 'env-rp-key';

    const resolver = createCredentialResolver(store);
    const creds = await resolver.resolve('user-1', 'runpod');
    expect(creds!.apiKey).toBe('env-rp-key');
  });

  it('falls back to env vars when settings empty', async () => {
    const store = makeSettingsStore({});
    process.env.VAST_API_KEY = 'env-vast-key';

    const resolver = createCredentialResolver(store);
    const creds = await resolver.resolve('user-1', 'vast');
    expect(creds!.apiKey).toBe('env-vast-key');
  });

  it('returns null when no settings and no env vars', async () => {
    const store = makeSettingsStore({});
    const resolver = createCredentialResolver(store);
    const creds = await resolver.resolve('user-1', 'runpod');
    expect(creds).toBeNull();
  });

  it('returns null for unknown provider', async () => {
    const store = makeSettingsStore({ skypilot: { unknownKey: 'value' } });
    const resolver = createCredentialResolver(store);
    const creds = await resolver.resolve('user-1', 'unknown-provider');
    expect(creds).toBeNull();
  });

  it('includes hfToken from env fallback', async () => {
    const store = makeSettingsStore({});
    process.env.TENSORDOCK_API_KEY = 'td-env-key';
    process.env.HF_TOKEN = 'hf-env-token';

    const resolver = createCredentialResolver(store);
    const creds = await resolver.resolve('user-1', 'tensordock');
    expect(creds!.hfToken).toBe('hf-env-token');
  });

  it('includes authId from env for tensordock', async () => {
    const store = makeSettingsStore({});
    process.env.TENSORDOCK_API_KEY = 'td-key';
    process.env.TENSORDOCK_AUTH_ID = 'td-auth-env';

    const resolver = createCredentialResolver(store);
    const creds = await resolver.resolve('user-1', 'tensordock');
    expect(creds!.authId).toBe('td-auth-env');
  });

  it('handles settings store errors gracefully', async () => {
    const errorStore: SettingsStore = {
      async get() { throw new Error('DB error'); },
      async patch() {},
    };
    process.env.RUNPOD_API_KEY = 'env-fallback';

    const resolver = createCredentialResolver(errorStore);
    const creds = await resolver.resolve('user-1', 'runpod');
    // Should fall back to env vars
    expect(creds!.apiKey).toBe('env-fallback');
  });

  it('prefers user settings over env vars', async () => {
    const store = makeSettingsStore({
      skypilot: { vastApiKey: 'user-vast-key' },
    });
    process.env.VAST_API_KEY = 'env-vast-key';

    const resolver = createCredentialResolver(store);
    const creds = await resolver.resolve('user-1', 'vast');
    expect(creds!.apiKey).toBe('user-vast-key');
  });
});
