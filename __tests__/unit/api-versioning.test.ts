/**
 * Unit tests for src/middleware/api-versioning.ts
 *
 * Covers: extractVersion (URL path, Accept header, X-API-Version header,
 * unknown version fallback, null url), getVersionHeaders (active, deprecated
 * with and without sunset, Link href format), isDeprecatedVersion, and
 * versionMiddleware (attaches version, calls next, unknown stays v1).
 */
import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import {
  extractVersion,
  getVersionHeaders,
  isDeprecatedVersion,
  versionMiddleware,
  API_VERSIONS,
} from '../../src/middleware/api-versioning';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReq(
  url: string | undefined,
  headers: Record<string, string | string[] | undefined> = {},
): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}

// ── extractVersion ────────────────────────────────────────────────────────────

describe('extractVersion — URL path', () => {
  it('extracts v1 from /v1/ path prefix', () => {
    const v = extractVersion(makeReq('/v1/chat/completions'));
    expect(v).toBe(API_VERSIONS.v1);
    expect(v.major).toBe(1);
  });

  it('extracts v2 from /v2/ path prefix', () => {
    const v = extractVersion(makeReq('/v2/models'));
    expect(v).toBe(API_VERSIONS.v2);
    expect(v.major).toBe(2);
  });

  it('falls back to v1 for unknown path version /v99/', () => {
    const v = extractVersion(makeReq('/v99/chat'));
    expect(v).toBe(API_VERSIONS.v1);
  });

  it('falls back to v1 for path without version prefix', () => {
    const v = extractVersion(makeReq('/health'));
    expect(v).toBe(API_VERSIONS.v1);
  });

  it('falls back to v1 for root path', () => {
    expect(extractVersion(makeReq('/'))).toBe(API_VERSIONS.v1);
  });

  it('falls back to v1 when url is undefined (null url)', () => {
    const v = extractVersion(makeReq(undefined));
    expect(v).toBe(API_VERSIONS.v1);
  });
});

describe('extractVersion — Accept header', () => {
  it('extracts v2 from vendor Accept header', () => {
    const req = makeReq('/chat/completions', {
      accept: 'application/vnd.ai-gateway.v2+json',
    });
    expect(extractVersion(req)).toBe(API_VERSIONS.v2);
  });

  it('extracts v1 from vendor Accept header', () => {
    const req = makeReq('/chat/completions', {
      accept: 'application/vnd.ai-gateway.v1+json',
    });
    expect(extractVersion(req)).toBe(API_VERSIONS.v1);
  });

  it('ignores Accept header for unknown version', () => {
    const req = makeReq('/chat', {
      accept: 'application/vnd.ai-gateway.v99+json',
    });
    expect(extractVersion(req)).toBe(API_VERSIONS.v1);
  });

  it('URL path takes priority over Accept header', () => {
    const req = makeReq('/v1/chat', {
      accept: 'application/vnd.ai-gateway.v2+json',
    });
    // URL says v1, Accept says v2 → URL wins
    expect(extractVersion(req)).toBe(API_VERSIONS.v1);
  });

  it('falls back to v1 when Accept header is plain JSON (no vendor type)', () => {
    const req = makeReq('/chat', { accept: 'application/json' });
    expect(extractVersion(req)).toBe(API_VERSIONS.v1);
  });
});

describe('extractVersion — X-API-Version header', () => {
  it('extracts version from X-API-Version: 1', () => {
    const req = makeReq('/chat', { 'x-api-version': '1' });
    expect(extractVersion(req)).toBe(API_VERSIONS.v1);
  });

  it('extracts version from X-API-Version: 2', () => {
    const req = makeReq('/chat', { 'x-api-version': '2' });
    expect(extractVersion(req)).toBe(API_VERSIONS.v2);
  });

  it('falls back to v1 for unknown X-API-Version', () => {
    const req = makeReq('/chat', { 'x-api-version': '99' });
    expect(extractVersion(req)).toBe(API_VERSIONS.v1);
  });

  it('URL path takes priority over X-API-Version header', () => {
    const req = makeReq('/v1/chat', { 'x-api-version': '2' });
    expect(extractVersion(req)).toBe(API_VERSIONS.v1);
  });

  it('Accept header takes priority over X-API-Version header', () => {
    const req = makeReq('/chat', {
      accept: 'application/vnd.ai-gateway.v1+json',
      'x-api-version': '2',
    });
    expect(extractVersion(req)).toBe(API_VERSIONS.v1);
  });
});

// ── getVersionHeaders ─────────────────────────────────────────────────────────

describe('getVersionHeaders — active version', () => {
  it('returns X-API-Version for a non-deprecated version', () => {
    const headers = getVersionHeaders({ major: 1, minor: 0, deprecated: false });
    expect(headers['X-API-Version']).toBe('1.0');
    expect('Deprecation' in headers).toBe(false);
    expect('Sunset' in headers).toBe(false);
    expect('Link' in headers).toBe(false);
  });

  it('formats X-API-Version as major.minor', () => {
    const headers = getVersionHeaders({ major: 2, minor: 3, deprecated: false });
    expect(headers['X-API-Version']).toBe('2.3');
  });
});

describe('getVersionHeaders — deprecated version without sunset', () => {
  it('includes Deprecation: true and Link header', () => {
    const headers = getVersionHeaders({ major: 1, minor: 0, deprecated: true });
    expect(headers.Deprecation).toBe('true');
    expect(headers.Link).toContain('rel="deprecation"');
  });

  it('omits Sunset header when no sunset date is set', () => {
    const headers = getVersionHeaders({ major: 1, minor: 0, deprecated: true });
    expect('Sunset' in headers).toBe(false);
  });

  it('Link points to migration docs for the next major version', () => {
    const headers = getVersionHeaders({ major: 1, minor: 0, deprecated: true });
    expect(headers.Link).toContain('v1-to-v2');
  });
});

describe('getVersionHeaders — deprecated version with sunset', () => {
  it('includes Sunset header when sunset date is set', () => {
    const headers = getVersionHeaders({
      major: 1,
      minor: 0,
      deprecated: true,
      sunset: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    expect(headers.Sunset).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
  });

  it('does not emit empty Sunset even when deprecated (regression guard)', () => {
    const headers = getVersionHeaders({ major: 1, minor: 0, deprecated: true, sunset: undefined });
    if ('Sunset' in headers) {
      expect(headers.Sunset).not.toBe('');
    }
  });
});

// ── isDeprecatedVersion ───────────────────────────────────────────────────────

describe('isDeprecatedVersion', () => {
  it('returns false for an active version (v1 default)', () => {
    const req = makeReq('/v1/chat');
    expect(isDeprecatedVersion(req)).toBe(false);
  });

  it('returns false for an active v2 version', () => {
    const req = makeReq('/v2/chat');
    expect(isDeprecatedVersion(req)).toBe(false);
  });

  it('returns false when no version in URL (defaults to v1 which is not deprecated)', () => {
    expect(isDeprecatedVersion(makeReq('/health'))).toBe(false);
  });
});

// ── versionMiddleware ─────────────────────────────────────────────────────────

describe('versionMiddleware', () => {
  it('attaches apiVersion to request object', () => {
    const req = makeReq('/v1/chat') as unknown as Record<string, unknown> & IncomingMessage;
    const next = vi.fn();
    versionMiddleware(req, next);
    expect(req.apiVersion).toBeDefined();
    expect((req.apiVersion as { major: number }).major).toBe(1);
  });

  it('calls next() exactly once', () => {
    const req = makeReq('/v2/models');
    const next = vi.fn();
    versionMiddleware(req, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('attaches v2 when path contains /v2/', () => {
    const req = makeReq('/v2/models') as unknown as Record<string, unknown> & IncomingMessage;
    const next = vi.fn();
    versionMiddleware(req, next);
    expect((req.apiVersion as { major: number }).major).toBe(2);
  });

  it('defaults to v1 for unversioned path', () => {
    const req = makeReq('/metrics') as unknown as Record<string, unknown> & IncomingMessage;
    const next = vi.fn();
    versionMiddleware(req, next);
    expect((req.apiVersion as { major: number }).major).toBe(1);
  });

  it('still calls next() even when version is unknown (graceful fallback)', () => {
    const req = makeReq('/v99/chat');
    const next = vi.fn();
    versionMiddleware(req, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
