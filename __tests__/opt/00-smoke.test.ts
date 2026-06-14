import { describe, it, expect } from 'vitest';

// Smoke test: confirms the opt test harness (config, discovery, runner) works.
describe('opt harness smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
