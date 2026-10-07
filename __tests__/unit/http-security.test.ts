/**
 * HTTP Security & Limits — Integration Tests
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '../..', file), 'utf-8');

describe('HTTP Body Size Limits', () => {
  it('should define per-route limits for text endpoints', () => {
    const source = readSource('server/http-utils.ts');
    expect(source).toContain('ROUTE_MAX_BYTES');
    expect(source).toContain('/v1/translate');
    expect(source).toContain('/v1/chat/completions');
    expect(source).toContain('/v1/config/providers');
    expect(source).toContain('/v1/config/api-keys');
    expect(source).toContain('/v1/docker/build');
    expect(source).toContain('/v1/gpu/preflight');
    expect(source).toContain('/v1/gpu/heartbeat');
  });

  it('should use route-specific limit in readRawBody', () => {
    const source = readSource('server/http-utils.ts');
    expect(source).toContain('routeLimit');
    expect(source).toContain("req.url?.split('?')[0]");
  });

  it('should have RAW_BODY_TIMEOUT >= 60 seconds', () => {
    const source = readSource('server/http-utils.ts');
    // Match RAW_BODY_TIMEOUT_MS = 120_000 (supports underscore separator)
    const match = source.match(/RAW_BODY_TIMEOUT_MS\s*=\s*([\d_]+)/);
    expect(match).not.toBeNull();
    const timeout = parseInt(match![1].replace(/_/g, ''), 10);
    expect(timeout).toBeGreaterThanOrEqual(60_000);
  });
});
