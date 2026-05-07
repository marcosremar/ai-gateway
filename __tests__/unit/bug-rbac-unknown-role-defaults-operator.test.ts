/**
 * Regression test: parseRolesFromEnv should not silently grant OPERATOR
 * permissions to unknown role names — should default to READONLY (least privilege).
 *
 * Bug: When RBAC_ROLES contains a key with an unrecognized role string
 * (e.g. "sk-key:viewer"), the fallback is `ROLES.OPERATOR` (level 2).
 * This violates least privilege: an unknown/typo'd role should default to
 * the most restrictive level, not an elevated one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseRolesFromEnv, ROLES } from '../../src/middleware/rbac';

describe('parseRolesFromEnv with unknown role name', () => {
  const ENV_KEY = 'TEST_RBAC_ROLES';

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  // Behavior tightened: instead of silently defaulting to a role, the parser
  // now THROWS on unknown / missing / empty role strings. Throwing fails the
  // service start-up loudly so the operator fixes the typo, rather than
  // silently downgrading a key to readonly (which would still let bad config
  // ship to production undetected).
  it('throws on unknown role name', () => {
    process.env[ENV_KEY] = 'sk-viewer-key:viewer';
    expect(() => parseRolesFromEnv(ENV_KEY)).toThrow(/unknown role/);
  });

  it('throws on misspelled role', () => {
    process.env[ENV_KEY] = 'sk-key:redonly';
    expect(() => parseRolesFromEnv(ENV_KEY)).toThrow(/unknown role/);
  });

  it('should still correctly parse valid role names', () => {
    process.env[ENV_KEY] = 'sk-admin:admin,sk-op:operator,sk-ro:readonly';
    const mapping = parseRolesFromEnv(ENV_KEY);
    expect(mapping['sk-admin']).toBe(ROLES.ADMIN);
    expect(mapping['sk-op']).toBe(ROLES.OPERATOR);
    expect(mapping['sk-ro']).toBe(ROLES.READONLY);
  });

  it('throws on key without role colon', () => {
    process.env[ENV_KEY] = 'sk-no-role-colon';
    expect(() => parseRolesFromEnv(ENV_KEY)).toThrow(/missing role/);
  });

  it('throws on empty role (trailing colon)', () => {
    process.env[ENV_KEY] = 'sk-empty:';
    expect(() => parseRolesFromEnv(ENV_KEY)).toThrow(/missing role/);
  });
});
