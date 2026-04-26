/**
 * Regression test: requireRole with unknown/misspelled role name
 * should deny access, not grant it.
 *
 * Bug: roleHierarchy[role] returns undefined for unknown roles,
 * which defaults to 0 via ?? 0. Since any authenticated user has
 * level >= 0 (user=1, operator=2, admin=3), ALL users pass the check
 * for an unknown role. A typo in the required role name opens the
 * endpoint to everyone.
 */

import { describe, it, expect } from 'vitest';
import { requireRole } from '../../src/auth-middleware';

function createMockRequest(headers: Record<string, string> = {}) {
  return { method: 'POST', url: '/', headers } as any;
}

describe('requireRole with unknown role name', () => {
  const config = {
    validKeys: new Set(['sk-read-only-key']),
    roleMap: new Map([
      ['sk-read-only-key', 'readonly'],
    ]),
  };

  it('should DENY a readonly user from accessing a misspelled admin role', () => {
    const req = createMockRequest({ authorization: 'Bearer sk-read-only-key' });
    // Typo: "adm1n" instead of "admin" — should deny, but bug grants access
    const result = requireRole(req, 'adm1n', config);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('should DENY a readonly user from accessing an entirely unknown role', () => {
    const req = createMockRequest({ authorization: 'Bearer sk-read-only-key' });
    const result = requireRole(req, 'superadmin', config);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('should DENY a readonly user from accessing an empty-string role', () => {
    const req = createMockRequest({ authorization: 'Bearer sk-read-only-key' });
    const result = requireRole(req, '', config);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('should still ALLOW admin to access valid admin role', () => {
    const adminConfig = {
      validKeys: new Set(['sk-admin-key']),
      roleMap: new Map([
        ['sk-admin-key', 'admin'],
      ]),
    };
    const req = createMockRequest({ authorization: 'Bearer sk-admin-key' });
    const result = requireRole(req, 'admin', adminConfig);
    expect(result.ok).toBe(true);
  });
});
