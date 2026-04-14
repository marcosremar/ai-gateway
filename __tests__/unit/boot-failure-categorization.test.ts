/**
 * P2-3: Boot failure categorization + category-specific cooldowns
 */

import { describe, it, expect } from 'vitest';
import {
  classifyBootFailure,
  computeCooldownMs,
  type BootFailureCategory,
} from '../../src/autoscaler/boot-orchestrator';

describe('classifyBootFailure', () => {
  const cases: Array<[string, BootFailureCategory]> = [
    // Billing
    ['RunPod: account balance too low — add funds and retry', 'billing'],
    ['payment required', 'billing'],
    ['credit card declined', 'billing'],
    // Quota
    ['RunPod machine quota is 0 — account blocked', 'quota'],
    ['abuse flag triggered', 'quota'],
    // Docker image
    ['No module named modal', 'docker_image'],
    // No capacity
    ['No GPUs available on Vast.ai', 'no_capacity'],
    ['no instances found', 'no_capacity'],
    ['out of capacity', 'no_capacity'],
    ['all GPU types exhausted', 'no_capacity'],
    // SSH tunnel
    ['ssh_tunnel_exception: Permission denied', 'ssh_tunnel'],
    ['ssh tunnel failed for instance', 'ssh_tunnel'],
    // Timeout
    ['probe timeout after 20000ms', 'timeout'],
    ['request timed out', 'timeout'],
    // API error
    ['HTTP 500 internal server error', 'api_error'],
    ['rate limit exceeded', 'api_error'],
    ['API returned 502', 'api_error'],
    // Unknown / fallback
    ['something weird happened', 'unknown'],
    ['', 'unknown'],
  ];

  for (const [reason, expected] of cases) {
    it(`classifies "${reason.slice(0, 40)}" as ${expected}`, () => {
      expect(classifyBootFailure(reason)).toBe(expected);
    });
  }

  it('handles null and undefined gracefully', () => {
    expect(classifyBootFailure(null)).toBe('unknown');
    expect(classifyBootFailure(undefined)).toBe('unknown');
  });
});

describe('computeCooldownMs', () => {
  it('billing failures get 24h cooldown on the first failure', () => {
    expect(computeCooldownMs('billing', 1)).toBe(24 * 60 * 60_000);
  });

  it('billing failures stay at 24h even after repeated failures (no exponential)', () => {
    expect(computeCooldownMs('billing', 10)).toBe(24 * 60 * 60_000);
  });

  it('quota failures get 24h cooldown', () => {
    expect(computeCooldownMs('quota', 1)).toBe(24 * 60 * 60_000);
  });

  it('docker_image failures get 1h cooldown', () => {
    expect(computeCooldownMs('docker_image', 1)).toBe(60 * 60_000);
  });

  it('no_capacity failures start at 5 min', () => {
    expect(computeCooldownMs('no_capacity', 1)).toBe(5 * 60_000);
  });

  it('no_capacity failures grow exponentially but cap at 15 min', () => {
    // 5min, 10min, 20min (cap=15min), 40min (cap=15min)
    expect(computeCooldownMs('no_capacity', 1)).toBe(5 * 60_000);
    expect(computeCooldownMs('no_capacity', 2)).toBe(10 * 60_000);
    expect(computeCooldownMs('no_capacity', 3)).toBe(15 * 60_000); // capped
    expect(computeCooldownMs('no_capacity', 4)).toBe(15 * 60_000); // still capped
  });

  it('ssh_tunnel failures start at 2 min and cap at 15 min', () => {
    // 2min, 4min, 8min, 16min (cap=15min), 32min (cap=15min)
    expect(computeCooldownMs('ssh_tunnel', 1)).toBe(2 * 60_000);
    expect(computeCooldownMs('ssh_tunnel', 2)).toBe(4 * 60_000);
    expect(computeCooldownMs('ssh_tunnel', 3)).toBe(8 * 60_000);
    expect(computeCooldownMs('ssh_tunnel', 4)).toBe(15 * 60_000); // capped
  });

  it('api_error failures start at 2 min', () => {
    expect(computeCooldownMs('api_error', 1)).toBe(2 * 60_000);
  });

  it('unknown failures default to 10 min', () => {
    expect(computeCooldownMs('unknown', 1)).toBe(10 * 60_000);
  });

  it('unknown failures cap at 15 min even with high failCount', () => {
    expect(computeCooldownMs('unknown', 10)).toBe(15 * 60_000);
  });
});

describe('end-to-end: classify + compute', () => {
  it('a billing error → 24h cooldown', () => {
    const category = classifyBootFailure('account balance too low');
    expect(category).toBe('billing');
    expect(computeCooldownMs(category, 1)).toBe(24 * 60 * 60_000);
  });

  it('a no-capacity error on the 2nd attempt → 10 min cooldown', () => {
    const category = classifyBootFailure('No GPUs available on Vast.ai');
    expect(category).toBe('no_capacity');
    expect(computeCooldownMs(category, 2)).toBe(10 * 60_000);
  });

  it('the March 25 scenario: machine quota = 0 → 24h cooldown', () => {
    const category = classifyBootFailure('RunPod machine quota is 0 — account blocked');
    expect(category).toBe('quota');
    expect(computeCooldownMs(category, 1)).toBe(24 * 60 * 60_000);
  });

  it('a Modal "No module named" error → 1h cooldown (not retried fast)', () => {
    const category = classifyBootFailure('Modal failed after 3 attempts: No module named modal');
    expect(category).toBe('docker_image');
    expect(computeCooldownMs(category, 1)).toBe(60 * 60_000);
  });
});
