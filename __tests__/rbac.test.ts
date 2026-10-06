/**
 * Unit tests for src/middleware/rbac.ts.
 *
 * Covers: ROLES constants, createRoleChecker (hasRole, getRole, getKeysWithRole),
 * getRequiredRoleForEndpoint (prefix matching, fail-CLOSED default),
 * and parseRolesFromEnv (parsing, validation, error cases).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  ROLES,
  ROLE_NAMES,
  DEFAULT_ENDPOINT_ROLES,
  createRoleChecker,
  getRequiredRoleForEndpoint,
  parseRolesFromEnv,
} from '../src/middleware/rbac';

// ── ROLES constants ───────────────────────────────────────────────────────────

describe('ROLES', () => {
  it('READONLY < OPERATOR < ADMIN numerically', () => {
    expect(ROLES.READONLY).toBeLessThan(ROLES.OPERATOR);
    expect(ROLES.OPERATOR).toBeLessThan(ROLES.ADMIN);
  });

  it('ROLE_NAMES maps every role value to a string', () => {
    expect(ROLE_NAMES[ROLES.READONLY]).toBe('readonly');
    expect(ROLE_NAMES[ROLES.OPERATOR]).toBe('operator');
    expect(ROLE_NAMES[ROLES.ADMIN]).toBe('admin');
  });
});

// ── createRoleChecker ─────────────────────────────────────────────────────────

describe('createRoleChecker', () => {
  const mapping = {
    'sk-admin': ROLES.ADMIN,
    'sk-operator': ROLES.OPERATOR,
    'sk-readonly': ROLES.READONLY,
  };
  const checker = createRoleChecker(mapping);

  describe('hasRole', () => {
    it('returns true when key has exact required role', () => {
      expect(checker.hasRole('sk-admin', ROLES.ADMIN)).toBe(true);
      expect(checker.hasRole('sk-operator', ROLES.OPERATOR)).toBe(true);
      expect(checker.hasRole('sk-readonly', ROLES.READONLY)).toBe(true);
    });

    it('returns true when key has higher role than required', () => {
      expect(checker.hasRole('sk-admin', ROLES.OPERATOR)).toBe(true);
      expect(checker.hasRole('sk-admin', ROLES.READONLY)).toBe(true);
      expect(checker.hasRole('sk-operator', ROLES.READONLY)).toBe(true);
    });

    it('returns false when key has lower role than required', () => {
      expect(checker.hasRole('sk-readonly', ROLES.OPERATOR)).toBe(false);
      expect(checker.hasRole('sk-readonly', ROLES.ADMIN)).toBe(false);
      expect(checker.hasRole('sk-operator', ROLES.ADMIN)).toBe(false);
    });

    it('returns false for unknown API key', () => {
      expect(checker.hasRole('sk-unknown', ROLES.READONLY)).toBe(false);
      expect(checker.hasRole('', ROLES.READONLY)).toBe(false);
    });
  });

  describe('getRole', () => {
    it('returns the role for a known key', () => {
      expect(checker.getRole('sk-admin')).toBe(ROLES.ADMIN);
      expect(checker.getRole('sk-operator')).toBe(ROLES.OPERATOR);
      expect(checker.getRole('sk-readonly')).toBe(ROLES.READONLY);
    });

    it('returns undefined for an unknown key', () => {
      expect(checker.getRole('sk-missing')).toBeUndefined();
    });
  });

  describe('getKeysWithRole', () => {
    it('returns keys that have exactly the specified role', () => {
      expect(checker.getKeysWithRole(ROLES.ADMIN)).toEqual(['sk-admin']);
      expect(checker.getKeysWithRole(ROLES.OPERATOR)).toEqual(['sk-operator']);
      expect(checker.getKeysWithRole(ROLES.READONLY)).toEqual(['sk-readonly']);
    });

    it('returns empty array when no keys have the role', () => {
      const emptyChecker = createRoleChecker({});
      expect(emptyChecker.getKeysWithRole(ROLES.ADMIN)).toEqual([]);
    });

    it('returns all keys with a given role when multiple share it', () => {
      const multi = createRoleChecker({
        'sk-a1': ROLES.ADMIN,
        'sk-a2': ROLES.ADMIN,
        'sk-o1': ROLES.OPERATOR,
      });
      expect(multi.getKeysWithRole(ROLES.ADMIN)).toEqual(expect.arrayContaining(['sk-a1', 'sk-a2']));
      expect(multi.getKeysWithRole(ROLES.ADMIN)).toHaveLength(2);
    });
  });

  describe('empty mapping', () => {
    const emptyChecker = createRoleChecker({});

    it('hasRole always returns false', () => {
      expect(emptyChecker.hasRole('any', ROLES.READONLY)).toBe(false);
    });

    it('getRole returns undefined for all keys', () => {
      expect(emptyChecker.getRole('any')).toBeUndefined();
    });
  });
});

// ── getRequiredRoleForEndpoint ────────────────────────────────────────────────

describe('getRequiredRoleForEndpoint', () => {
  it('returns READONLY for /health', () => {
    expect(getRequiredRoleForEndpoint('/health')).toBe(ROLES.READONLY);
  });

  it('returns READONLY for /health/detail (more specific than /health)', () => {
    expect(getRequiredRoleForEndpoint('/health/detail')).toBe(ROLES.READONLY);
  });

  it('returns READONLY for /metrics', () => {
    expect(getRequiredRoleForEndpoint('/metrics')).toBe(ROLES.READONLY);
  });

  it('returns OPERATOR for /v1/speech', () => {
    expect(getRequiredRoleForEndpoint('/v1/speech')).toBe(ROLES.OPERATOR);
  });

  it('returns OPERATOR for /v1/gpu/deploy', () => {
    expect(getRequiredRoleForEndpoint('/v1/gpu/deploy')).toBe(ROLES.OPERATOR);
  });

  it('returns ADMIN for /v1/config', () => {
    expect(getRequiredRoleForEndpoint('/v1/config')).toBe(ROLES.ADMIN);
  });

  it('returns ADMIN for /v1/labs', () => {
    expect(getRequiredRoleForEndpoint('/v1/labs')).toBe(ROLES.ADMIN);
  });

  it('returns ADMIN (fail-CLOSED) for unknown paths', () => {
    expect(getRequiredRoleForEndpoint('/unknown/endpoint')).toBe(ROLES.ADMIN);
    expect(getRequiredRoleForEndpoint('/v1/secret-new-feature')).toBe(ROLES.ADMIN);
    expect(getRequiredRoleForEndpoint('/')).toBe(ROLES.ADMIN);
  });

  it('picks the most specific prefix match', () => {
    const custom = {
      '/v1': ROLES.ADMIN,
      '/v1/gpu': ROLES.OPERATOR,
      '/v1/gpu/status': ROLES.READONLY,
    };
    // /v1/gpu/status → READONLY (most specific)
    expect(getRequiredRoleForEndpoint('/v1/gpu/status', custom)).toBe(ROLES.READONLY);
    // /v1/gpu/deploy → OPERATOR (matches /v1/gpu but not /v1/gpu/status)
    expect(getRequiredRoleForEndpoint('/v1/gpu/deploy', custom)).toBe(ROLES.OPERATOR);
    // /v1/chat → ADMIN (matches /v1 only)
    expect(getRequiredRoleForEndpoint('/v1/chat', custom)).toBe(ROLES.ADMIN);
  });

  it('custom mapping overrides DEFAULT_ENDPOINT_ROLES', () => {
    const custom = { '/health': ROLES.ADMIN };
    expect(getRequiredRoleForEndpoint('/health', custom)).toBe(ROLES.ADMIN);
  });

  it('returns ADMIN for unknown path with custom empty mapping', () => {
    expect(getRequiredRoleForEndpoint('/anything', {})).toBe(ROLES.ADMIN);
  });
});

// ── parseRolesFromEnv ─────────────────────────────────────────────────────────

describe('parseRolesFromEnv', () => {
  afterEach(() => {
    delete process.env.RBAC_ROLES;
    delete process.env.TEST_RBAC;
  });

  it('returns empty mapping when env var is unset', () => {
    delete process.env.RBAC_ROLES;
    expect(parseRolesFromEnv()).toEqual({});
  });

  it('returns empty mapping when env var is empty string', () => {
    process.env.RBAC_ROLES = '';
    expect(parseRolesFromEnv()).toEqual({});
  });

  it('parses a single admin key', () => {
    process.env.RBAC_ROLES = 'sk-abc:admin';
    expect(parseRolesFromEnv()).toEqual({ 'sk-abc': ROLES.ADMIN });
  });

  it('parses multiple keys with different roles', () => {
    process.env.RBAC_ROLES = 'sk-a:admin,sk-b:operator,sk-c:readonly';
    const result = parseRolesFromEnv();
    expect(result).toEqual({
      'sk-a': ROLES.ADMIN,
      'sk-b': ROLES.OPERATOR,
      'sk-c': ROLES.READONLY,
    });
  });

  it('uses a custom env var name', () => {
    process.env.TEST_RBAC = 'sk-x:admin';
    expect(parseRolesFromEnv('TEST_RBAC')).toEqual({ 'sk-x': ROLES.ADMIN });
  });

  it('handles whitespace around entries', () => {
    process.env.RBAC_ROLES = ' sk-a:admin , sk-b:operator ';
    const result = parseRolesFromEnv();
    expect(result['sk-a']).toBe(ROLES.ADMIN);
    expect(result['sk-b']).toBe(ROLES.OPERATOR);
  });

  it('role name is case-insensitive', () => {
    process.env.RBAC_ROLES = 'sk-a:ADMIN,sk-b:Operator,sk-c:READONLY';
    const result = parseRolesFromEnv();
    expect(result['sk-a']).toBe(ROLES.ADMIN);
    expect(result['sk-b']).toBe(ROLES.OPERATOR);
    expect(result['sk-c']).toBe(ROLES.READONLY);
  });

  it('skips entries with empty key (no warning assert needed)', () => {
    process.env.RBAC_ROLES = ':admin,sk-b:operator';
    const result = parseRolesFromEnv();
    expect(result['']).toBeUndefined();
    expect(result['sk-b']).toBe(ROLES.OPERATOR);
  });

  it('throws for an entry with an unknown role', () => {
    process.env.RBAC_ROLES = 'sk-a:superadmin';
    expect(() => parseRolesFromEnv()).toThrow('unknown role');
  });

  it('throws for an entry missing the role part', () => {
    process.env.RBAC_ROLES = 'sk-a';
    expect(() => parseRolesFromEnv()).toThrow('missing role');
  });

  it('handles trailing comma gracefully (skips empty entries)', () => {
    process.env.RBAC_ROLES = 'sk-a:admin,';
    // trailing comma produces empty entry — should skip without throwing
    const result = parseRolesFromEnv();
    expect(result['sk-a']).toBe(ROLES.ADMIN);
  });
});
