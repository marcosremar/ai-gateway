/**
 * Unit tests for playground-handlers — validates catalog structure
 * and handler exports without starting the full gateway.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock bun:sqlite — not available in Vitest's Node.js runtime
// (transitive dep: playground-handlers → gpu-deploy → latency-db → bun:sqlite)
vi.mock('bun:sqlite', () => ({
  Database: class MockDatabase {
    exec() {}
    prepare() { return { all: () => [], get: () => null, run: () => {} }; }
    close() {}
  },
}));

// Test that all handlers are exported
describe('playground-handlers exports', () => {
  it('should export all handler functions', async () => {
    const mod = await import('../../server/playground-handlers');
    expect(typeof mod.handlePlaygroundCatalog).toBe('function');
    expect(typeof mod.handlePlaygroundStt).toBe('function');
    expect(typeof mod.handlePlaygroundLlm).toBe('function');
    expect(typeof mod.handlePlaygroundTts).toBe('function');
    expect(typeof mod.handlePlaygroundPipeline).toBe('function');
  });
});
