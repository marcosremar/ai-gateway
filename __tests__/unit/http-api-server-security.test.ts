import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeHttpRequest,
  isPublicHttpRoute,
  resolveHttpCorsOrigin,
} from '../../server/ws/http-api-server';

const ORIGINAL_GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;
const ORIGINAL_CORS_ORIGINS = process.env.CORS_ORIGINS;

afterEach(() => {
  if (ORIGINAL_GATEWAY_API_KEY === undefined) delete process.env.GATEWAY_API_KEY;
  else process.env.GATEWAY_API_KEY = ORIGINAL_GATEWAY_API_KEY;

  if (ORIGINAL_CORS_ORIGINS === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = ORIGINAL_CORS_ORIGINS;
});

describe('HTTP API server security helpers', () => {
  it('treats only /health as a public route', () => {
    expect(isPublicHttpRoute('GET', '/health')).toBe(true);
    expect(isPublicHttpRoute('HEAD', '/health')).toBe(true);
    expect(isPublicHttpRoute('GET', '/metrics')).toBe(false);
    expect(isPublicHttpRoute('POST', '/v1/config/api-keys')).toBe(false);
  });

  it('requires a valid bearer token when GATEWAY_API_KEY is configured', () => {
    process.env.GATEWAY_API_KEY = 'super-secret-gateway-key';

    expect(authorizeHttpRequest('POST', '/v1/config/api-keys', null, '203.0.113.7')).toEqual({
      ok: false,
      status: 401,
      message: 'Invalid or missing API key',
    });

    expect(authorizeHttpRequest('POST', '/v1/config/api-keys', 'Bearer wrong', '203.0.113.7')).toEqual({
      ok: false,
      status: 401,
      message: 'Invalid or missing API key',
    });

    expect(authorizeHttpRequest('POST', '/v1/config/api-keys', 'Bearer super-secret-gateway-key', '203.0.113.7')).toEqual({
      ok: true,
    });
  });

  it('falls back to localhost-only access when no gateway key is configured', () => {
    delete process.env.GATEWAY_API_KEY;

    expect(authorizeHttpRequest('GET', '/v1/gpu/status', null, '127.0.0.1')).toEqual({ ok: true });
    expect(authorizeHttpRequest('GET', '/v1/gpu/status', null, '::1')).toEqual({ ok: true });
    expect(authorizeHttpRequest('GET', '/v1/gpu/status', null, '198.51.100.22')).toEqual({
      ok: false,
      status: 401,
      message: 'No GATEWAY_API_KEY configured — remote access denied. Set GATEWAY_API_KEY or connect from localhost.',
    });
  });

  it('allows only configured or local CORS origins', () => {
    process.env.CORS_ORIGINS = 'https://admin.example.com';

    expect(resolveHttpCorsOrigin('https://admin.example.com')).toBe('https://admin.example.com');
    expect(resolveHttpCorsOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(resolveHttpCorsOrigin('https://evil.example.com')).toBeNull();
    expect(resolveHttpCorsOrigin(null)).toBeNull();
  });
});
