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

  it('should default unknown role to READONLY (least privilege), not OPERATOR', () => {
    process.env[ENV_KEY] = 'sk-viewer-key:viewer';
    const mapping = parseRolesFromEnv(ENV_KEY);
    expect(mapping['sk-viewer-key']).toBe(ROLES.READONLY);
  });

  it('should default misspelled role to READONLY', () => {
    process.env[ENV_KEY] = 'sk-key:redonly';
    const mapping = parseRolesFromEnv(ENV_KEY);
    expect(mapping['sk-key']).toBe(ROLES.READONLY);
  });

  it('should still correctly parse valid role names', () => {
    process.env[ENV_KEY] = 'sk-admin:admin,sk-op:operator,sk-ro:readonly';
    const mapping = parseRolesFromEnv(ENV_KEY);
    expect(mapping['sk-admin']).toBe(ROLES.ADMIN);
    expect(mapping['sk-op']).toBe(ROLES.OPERATOR);
    expect(mapping['sk-ro']).toBe(ROLES.READONLY);
  });

  it('should default key without role colon to READONLY', () => {
    process.env[ENV_KEY] = 'sk-no-role-colon';
    const mapping = parseRolesFromEnv(ENV_KEY);
    expect(mapping['sk-no-role-colon']).toBe(ROLES.READONLY);
  });

  it('should default empty role (trailing colon) to READONLY', () => {
    process.env[ENV_KEY] = 'sk-empty:';
    const mapping = parseRolesFromEnv(ENV_KEY);
    expect(mapping['sk-empty']).toBe(ROLES.READONLY);
  });
});
