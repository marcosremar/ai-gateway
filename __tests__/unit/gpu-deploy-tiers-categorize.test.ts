// ── categorizeDeployFailure unit tests ────────────────────────────────────────
// Tests the pure string-classification function in server/gpu-deploy-tiers.ts.
// Previous tests only verified string presence in the source; these call the
// real function to confirm every branch produces the right category.

import { describe, it, expect, vi } from 'vitest';

// ── Mocks (must be declared before any import of the module under test) ────────

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Stub all provider clients — we don't call them in this test file
vi.mock('../../server/providers', () => ({
  runpod: {},
  vast: {},
  vastVm: {},
  tensordock: {},
  modal: {},
  snapgpu: {},
  hyperstack: {},
}));

vi.mock('../../server/config', () => ({ PROVIDER_CHAIN: [] }));

// Return tiers in input order so buildGpuTiers is deterministic
vi.mock('../../server/tier-ranking', () => ({
  reorderByLatency: (tiers: unknown[]) => tiers,
}));

// ── Import function under test ─────────────────────────────────────────────────

import { categorizeDeployFailure } from '../../server/gpu-deploy-tiers';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('categorizeDeployFailure — app_error', () => {
  it('classifies "app load failed" message', () => {
    expect(categorizeDeployFailure('App load failed: model not found')).toBe('app_error');
  });

  it('classifies "app_error" substring (any case)', () => {
    expect(categorizeDeployFailure('Caught APP_ERROR from worker')).toBe('app_error');
  });

  it('classifies "model failed to load" message', () => {
    expect(categorizeDeployFailure('model failed to load: out of memory')).toBe('app_error');
  });

  it('is case-insensitive for app_error patterns', () => {
    expect(categorizeDeployFailure('APP LOAD FAILED after 5 retries')).toBe('app_error');
  });
});

describe('categorizeDeployFailure — billing', () => {
  it('classifies insufficient balance message', () => {
    expect(categorizeDeployFailure('Insufficient balance: need $2.00 more')).toBe('billing');
  });

  it('classifies "funds" substring', () => {
    expect(categorizeDeployFailure('Not enough funds in account')).toBe('billing');
  });

  it('classifies "insufficient" standalone', () => {
    expect(categorizeDeployFailure('Disk quota insufficient')).toBe('billing');
  });

  it('classifies "need at least" (RunPod phrasing)', () => {
    expect(categorizeDeployFailure('You need at least $1.00 to start this pod')).toBe('billing');
  });

  it('classifies "balance" substring', () => {
    expect(categorizeDeployFailure('account balance is zero')).toBe('billing');
  });
});

describe('categorizeDeployFailure — docker_image', () => {
  it('classifies "image" + "pull" error', () => {
    expect(categorizeDeployFailure('Failed to pull image: timeout')).toBe('docker_image');
  });

  it('classifies "image" + "not found"', () => {
    expect(categorizeDeployFailure('Docker image not found in registry')).toBe('docker_image');
  });

  it('classifies "image" + "manifest"', () => {
    expect(categorizeDeployFailure('image manifest unknown error')).toBe('docker_image');
  });

  it('classifies "image" + "registry"', () => {
    expect(categorizeDeployFailure('Could not reach image registry')).toBe('docker_image');
  });

  it('classifies "docker error" without image keyword', () => {
    expect(categorizeDeployFailure('docker error: failed to start container')).toBe('docker_image');
  });

  it('classifies "docker failed"', () => {
    expect(categorizeDeployFailure('docker failed with exit code 1')).toBe('docker_image');
  });

  it('is case-insensitive for Docker patterns', () => {
    expect(categorizeDeployFailure('DOCKER IMAGE not found')).toBe('docker_image');
  });
});

describe('categorizeDeployFailure — cancelled', () => {
  it('classifies "cancelled" (UK spelling)', () => {
    expect(categorizeDeployFailure('Deploy cancelled by user')).toBe('cancelled');
  });

  it('classifies "canceled" (US spelling)', () => {
    expect(categorizeDeployFailure('Job canceled due to timeout')).toBe('canceled' === 'cancelled' ? 'cancelled' : 'cancelled');
    expect(categorizeDeployFailure('Job canceled due to timeout')).toBe('cancelled');
  });
});

describe('categorizeDeployFailure — timeout', () => {
  it('classifies "timed out" message', () => {
    expect(categorizeDeployFailure('Pod creation timed out after 20 minutes')).toBe('timeout');
  });

  it('classifies "timeout" substring', () => {
    expect(categorizeDeployFailure('Request timeout: no response from provider')).toBe('timeout');
  });

  it('is case-insensitive', () => {
    expect(categorizeDeployFailure('TIMED OUT waiting for endpoint')).toBe('timeout');
  });
});

describe('categorizeDeployFailure — crashed', () => {
  it('classifies "crashed" message', () => {
    expect(categorizeDeployFailure('Worker process crashed with SIGSEGV')).toBe('crashed');
  });

  it('classifies "exited" message', () => {
    expect(categorizeDeployFailure('Container exited with code 137')).toBe('crashed');
  });

  it('classifies "terminated" message', () => {
    expect(categorizeDeployFailure('Instance terminated unexpectedly')).toBe('crashed');
  });

  it('is case-insensitive', () => {
    expect(categorizeDeployFailure('Process CRASHED during model load')).toBe('crashed');
  });
});

describe('categorizeDeployFailure — api_error', () => {
  it('classifies "api" substring (lowercase)', () => {
    expect(categorizeDeployFailure('api auth failed: invalid key')).toBe('api_error');
  });

  it('classifies HTTP 401 status code', () => {
    expect(categorizeDeployFailure('HTTP 401 Unauthorized from provider')).toBe('api_error');
  });

  it('classifies HTTP 402 Payment Required', () => {
    expect(categorizeDeployFailure('Provider returned 402 payment required')).toBe('api_error');
  });

  it('classifies HTTP 403 Forbidden', () => {
    // Note: "403 Forbidden" without "insufficient" — billing is checked first
    // and "insufficient" would match billing before reaching the api_error branch.
    expect(categorizeDeployFailure('403 Forbidden: access denied')).toBe('api_error');
  });

  it('classifies HTTP 429 Rate Limited', () => {
    expect(categorizeDeployFailure('429 Too Many Requests — back off')).toBe('api_error');
  });

  it('classifies HTTP 500 Internal Server Error', () => {
    expect(categorizeDeployFailure('Provider returned 500 Internal Server Error')).toBe('api_error');
  });

  it('classifies HTTP 502 Bad Gateway', () => {
    expect(categorizeDeployFailure('502 Bad Gateway from upstream')).toBe('api_error');
  });

  it('classifies HTTP 503 Service Unavailable', () => {
    expect(categorizeDeployFailure('503 Service Unavailable')).toBe('api_error');
  });

  it('classifies HTTP 504 by status code alone', () => {
    // Note: "Gateway Timeout" contains "timeout" which is checked before "504"
    // so the plain status code without the word "timeout" is used here.
    expect(categorizeDeployFailure('Provider returned 504')).toBe('api_error');
  });
});

describe('categorizeDeployFailure — network', () => {
  it('classifies "network" error', () => {
    expect(categorizeDeployFailure('Network error: unable to connect')).toBe('network');
  });

  it('classifies "econnrefused" (Node.js errno)', () => {
    expect(categorizeDeployFailure('ECONNREFUSED 127.0.0.1:8080')).toBe('network');
  });

  it('classifies "etimedout" (Node.js errno)', () => {
    expect(categorizeDeployFailure('connect ETIMEDOUT 10.0.0.1:443')).toBe('network');
  });

  it('classifies "fetch failed"', () => {
    expect(categorizeDeployFailure('fetch failed: connection refused')).toBe('network');
  });

  it('is case-insensitive', () => {
    expect(categorizeDeployFailure('NETWORK ERROR: Host unreachable')).toBe('network');
  });
});

describe('categorizeDeployFailure — unknown fallthrough', () => {
  it('returns "unknown" for empty string', () => {
    expect(categorizeDeployFailure('')).toBe('unknown');
  });

  it('returns "unknown" for generic error messages', () => {
    expect(categorizeDeployFailure('Something went wrong')).toBe('unknown');
  });

  it('returns "unknown" for unrecognized error codes', () => {
    expect(categorizeDeployFailure('error code 42')).toBe('unknown');
  });

  it('returns "unknown" for whitespace-only strings', () => {
    expect(categorizeDeployFailure('   ')).toBe('unknown');
  });
});

describe('categorizeDeployFailure — priority ordering', () => {
  it('app_error takes precedence over timeout in ambiguous messages', () => {
    // "app load failed" matches app_error first (before timeout check)
    expect(categorizeDeployFailure('app load failed: timed out waiting for model')).toBe('app_error');
  });

  it('billing takes precedence over network when both keywords present', () => {
    // "insufficient" is checked (billing) before "network" check
    expect(categorizeDeployFailure('insufficient balance: network error')).toBe('billing');
  });

  it('billing takes precedence over api_error when "insufficient" is present', () => {
    // billing is checked before api_error, so "403 Forbidden: insufficient permissions"
    // returns "billing" because "insufficient" triggers it first.
    expect(categorizeDeployFailure('403 Forbidden: insufficient permissions')).toBe('billing');
  });

  it('timeout takes precedence over api_error when "timeout" appears in the message', () => {
    // "timeout" is checked before "504" (api_error), so "504 Gateway Timeout" → timeout.
    expect(categorizeDeployFailure('504 Gateway Timeout exceeded')).toBe('timeout');
  });

  it('docker_image takes precedence when image + pull conflict with api keyword', () => {
    // "image pull" matches docker_image; "401" alone would be api_error
    // If both match, docker_image is checked first
    expect(categorizeDeployFailure('failed to pull image: received 401')).toBe('docker_image');
  });
});
