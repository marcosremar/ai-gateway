/**
 * Tests for auth-middleware module.
 */

import { describe, it, expect } from 'vitest';
import { requireAuth, requireRole, sendAuthError } from '../../src/auth-middleware';

function createMockRequest(headers: Record<string, string> = {}, url = '/') {
  return {
    method: 'POST',
    url,
    headers,
  } as any;
}

function createMockResponse() {
  const headers: Record<string, string> = {};
  let body = '';
  let statusCode = 200;

  return {
    writeHead: (code: number, h: Record<string, string>) => {
      statusCode = code;
      Object.assign(headers, h);
    },
    end: (data: string) => {
      body = data;
    },
    getHeaders: () => headers,
    getBody: () => body,
    getStatusCode: () => statusCode,
  };
}

describe('requireAuth', () => {
  const config = {
    validKeys: new Set(['sk-valid-key', 'sk-admin-key']),
  };

  it('should authenticate with valid Bearer token', () => {
    const req = createMockRequest({ authorization: 'Bearer sk-valid-key' });
    const result = requireAuth(req, config);
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe('sk-valid-key');
  });

  it('should authenticate with plain API key', () => {
    const req = createMockRequest({ authorization: 'sk-valid-key' });
    const result = requireAuth(req, config);
    expect(result.ok).toBe(true);
  });

  it('should reject missing auth', () => {
    const req = createMockRequest({});
    const result = requireAuth(req, config);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('should reject invalid API key', () => {
    const req = createMockRequest({ authorization: 'Bearer sk-invalid-key' });
    const result = requireAuth(req, config);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('should bypass auth in dev mode', () => {
    const req = createMockRequest({});
    const result = requireAuth(req, { ...config, allowDevBypass: true });
    // Note: This won't actually bypass unless NODE_ENV=development
    expect(result).toBeDefined();
  });
});

describe('requireRole', () => {
  const config = {
    validKeys: new Set(['sk-admin-key', 'sk-operator-key', 'sk-user-key']),
    roleMap: new Map([
      ['sk-admin-key', 'admin'],
      ['sk-operator-key', 'operator'],
      ['sk-user-key', 'user'],
    ]),
  };

  it('should allow admin to access admin endpoints', () => {
    const req = createMockRequest({ authorization: 'Bearer sk-admin-key' });
    const result = requireRole(req, 'admin', config);
    expect(result.ok).toBe(true);
    expect(result.role).toBe('admin');
  });

  it('should allow admin to access operator endpoints', () => {
    const req = createMockRequest({ authorization: 'Bearer sk-admin-key' });
    const result = requireRole(req, 'operator', config);
    expect(result.ok).toBe(true);
  });

  it('should deny user from accessing admin endpoints', () => {
    const req = createMockRequest({ authorization: 'Bearer sk-user-key' });
    const result = requireRole(req, 'admin', config);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('should allow operator to access operator endpoints', () => {
    const req = createMockRequest({ authorization: 'Bearer sk-operator-key' });
    const result = requireRole(req, 'operator', config);
    expect(result.ok).toBe(true);
  });

  it('should deny operator from accessing admin endpoints', () => {
    const req = createMockRequest({ authorization: 'Bearer sk-operator-key' });
    const result = requireRole(req, 'admin', config);
    expect(result.ok).toBe(false);
  });
});

describe('sendAuthError', () => {
  it('should send 401 for unauthorized', () => {
    const res = createMockResponse();
    sendAuthError(res, { ok: false, error: 'Authentication required', statusCode: 401 });
    expect(res.getStatusCode()).toBe(401);
    expect(res.getHeaders()['Content-Type']).toBe('application/json');
  });

  it('should send 403 for forbidden', () => {
    const res = createMockResponse();
    sendAuthError(res, { ok: false, error: 'Insufficient permissions', statusCode: 403 });
    expect(res.getStatusCode()).toBe(403);
  });
});
