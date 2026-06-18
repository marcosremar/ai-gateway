import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { aliasEnv, normalizeProviderEnvAliases } from '../../src/env-aliases';

describe('env-aliases', () => {
  const A = 'AIGW_TEST_ALIAS_A';
  const B = 'AIGW_TEST_ALIAS_B';

  beforeEach(() => {
    delete process.env[A];
    delete process.env[B];
  });
  afterEach(() => {
    delete process.env[A];
    delete process.env[B];
  });

  it('mirrors A → B when only A is set', () => {
    process.env[A] = 'val-a';
    aliasEnv(A, B);
    expect(process.env[B]).toBe('val-a');
  });

  it('mirrors B → A when only B is set', () => {
    process.env[B] = 'val-b';
    aliasEnv(A, B);
    expect(process.env[A]).toBe('val-b');
  });

  it('does not overwrite when both are explicitly set', () => {
    process.env[A] = 'a';
    process.env[B] = 'b';
    aliasEnv(A, B);
    expect(process.env[A]).toBe('a');
    expect(process.env[B]).toBe('b');
  });

  it('does nothing when neither is set', () => {
    aliasEnv(A, B);
    expect(process.env[A]).toBeUndefined();
    expect(process.env[B]).toBeUndefined();
  });

  it('normalizeProviderEnvAliases is idempotent and safe to call repeatedly', () => {
    expect(() => normalizeProviderEnvAliases()).not.toThrow();
    expect(() => normalizeProviderEnvAliases()).not.toThrow();
  });
});
