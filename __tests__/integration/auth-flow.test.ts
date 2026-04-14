/**
 * Integration test: Full auth flow.
 *
 * Fixes: #641 (integration testing)
 */

import { describe, it, expect } from 'vitest';
import { requireAuth, requireRole } from '../../src/auth-middleware';

describe('Integration: Auth Flow', () => {
  it('should authenticate with Bearer token', () => {
    const req = {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-valid-key' },
    } as any;

    const config = { validKeys: new Set(['sk-valid-key']) };
    const result = requireAuth(req, config);

    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe('sk-valid-key');
  });

  it('should reject unauthenticated requests', () => {
    const req = {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {},
    } as any;

    const config = { validKeys: new Set(['sk-valid-key']) };
    const result = requireAuth(req, config);

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('should enforce role-based access', () => {
    const req = {
      method: 'POST',
      url: '/v1/gpu/deploy',
      headers: { authorization: 'Bearer sk-user-key' },
    } as any;

    const config = {
      validKeys: new Set(['sk-user-key']),
      roleMap: new Map([['sk-user-key', 'user']]),
    };

    const result = requireRole(req, 'admin', config);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
  });
});
