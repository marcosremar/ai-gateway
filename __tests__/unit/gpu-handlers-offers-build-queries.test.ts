/**
 * Unit tests for buildProviderQueries() in server/gpu-handlers-offers.ts
 *
 * The function maps API-key availability + an optional provider filter to an
 * ordered array of { name, client, credentials } objects. It is used by every
 * GPU-offer listing endpoint, so correctness here gates all provider selection
 * downstream.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock calls are hoisted, so factory bodies must not reference outer let/const.
// All mock object state is set up inline and retrieved via dynamic import or
// vi.mocked() after the static import at the bottom.

vi.mock('../../server/state', () => ({
  prisma: {},
  deployState: { podId: '', endpoint: '', status: 'idle', dockerImage: '', gpuType: '', provider: '' },
  deployApiKey: '',
  deployCancelled: false,
}));

vi.mock('../../server/providers', () => ({
  runpod:     { listOffers: vi.fn(), checkBalance: vi.fn() },
  vast:       { listOffers: vi.fn(), checkBalance: vi.fn() },
  tensordock: { listOffers: vi.fn(), checkBalance: vi.fn() },
  modal:      { listOffers: vi.fn() },
}));

vi.mock('../../server/config', () => ({
  PORT: 3001,
  LOW_BALANCE_THRESHOLD_USD: 1,
}));

vi.mock('../../server/http-utils', () => ({
  getOrCreateRequestId: vi.fn(() => 'req-id'),
  setRequestIdHeader: vi.fn(),
  validateGpuCredentials: vi.fn(() => null),
}));

vi.mock('../../server/ip-location', () => ({
  fetchMyLocation: vi.fn(),
}));

vi.mock('../../server/gpu-latency', () => ({
  rankOffers: vi.fn((offers: unknown[]) => offers),
  scheduleBackgroundProbes: vi.fn(),
  probeAndSaveOffers: vi.fn(() => ({})),
}));

vi.mock('../../server/latency-db', () => ({
  upsertHostMeta: vi.fn(),
  getHostRttMap: vi.fn(() => ({})),
  getBestLatencyByGpuModel: vi.fn(() => ({})),
}));

vi.mock('../../src/safe-catch', () => ({
  safeCatch: vi.fn(() => (_err: unknown) => {}),
}));

import { buildProviderQueries } from '../../server/gpu-handlers-offers';
// Retrieve the mocked provider objects so we can do identity checks
import * as mockProviders from '../../server/providers';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildProviderQueries', () => {
  // ── No credentials ──────────────────────────────────────────────────────────

  it('returns empty array when no credentials are provided', () => {
    expect(buildProviderQueries({})).toEqual([]);
  });

  it('returns empty array when all keys are empty strings', () => {
    const result = buildProviderQueries({
      runpodApiKey: '',
      vastApiKey: '',
      tensordockApiKey: '',
      tensordockAuthId: '',
      modalApiKey: '',
    });
    expect(result).toEqual([]);
  });

  // ── Single provider credentials ─────────────────────────────────────────────

  it('returns only runpod entry when only runpodApiKey is set', () => {
    const result = buildProviderQueries({ runpodApiKey: 'rp_key_123' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('runpod');
    expect(result[0].credentials).toEqual({ apiKey: 'rp_key_123' });
    expect(result[0].client).toBe(mockProviders.runpod);
  });

  it('returns only vast entry when only vastApiKey is set', () => {
    const result = buildProviderQueries({ vastApiKey: 'vast_key_abc' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('vast');
    expect(result[0].credentials).toEqual({ apiKey: 'vast_key_abc' });
    expect(result[0].client).toBe(mockProviders.vast);
  });

  it('returns only modal entry when only modalApiKey is set', () => {
    const result = buildProviderQueries({ modalApiKey: 'tok_id:tok_secret' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('modal');
    expect(result[0].credentials).toEqual({ apiKey: 'tok_id:tok_secret' });
    expect(result[0].client).toBe(mockProviders.modal);
  });

  // ── TensorDock requires BOTH keys ────────────────────────────────────────────

  it('returns tensordock when both tensordockApiKey and tensordockAuthId are set', () => {
    const result = buildProviderQueries({ tensordockApiKey: 'td_key', tensordockAuthId: 'td_auth' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('tensordock');
    expect(result[0].credentials).toEqual({ apiKey: 'td_key', authId: 'td_auth' });
    expect(result[0].client).toBe(mockProviders.tensordock);
  });

  it('omits tensordock when only tensordockApiKey is set (no authId)', () => {
    const result = buildProviderQueries({ tensordockApiKey: 'td_key' });
    expect(result).toEqual([]);
  });

  it('omits tensordock when only tensordockAuthId is set (no apiKey)', () => {
    const result = buildProviderQueries({ tensordockAuthId: 'td_auth' });
    expect(result).toEqual([]);
  });

  // ── All providers, no filter ──────────────────────────────────────────────────

  it('returns all four providers when all credentials are set and no filter', () => {
    const result = buildProviderQueries({
      runpodApiKey: 'rp_key',
      vastApiKey: 'vast_key',
      tensordockApiKey: 'td_key',
      tensordockAuthId: 'td_auth',
      modalApiKey: 'modal_key',
    });
    expect(result).toHaveLength(4);
    expect(result.map(q => q.name)).toEqual(['runpod', 'vast', 'tensordock', 'modal']);
  });

  it('preserves declaration order: runpod → vast → tensordock → modal', () => {
    // Pass keys in reversed order — order must be determined by buildProviderQueries, not opts key order
    const result = buildProviderQueries({
      modalApiKey: 'modal_key',
      tensordockApiKey: 'td_key',
      tensordockAuthId: 'td_auth',
      vastApiKey: 'vast_key',
      runpodApiKey: 'rp_key',
    });
    expect(result.map(q => q.name)).toEqual(['runpod', 'vast', 'tensordock', 'modal']);
  });

  // ── Provider filter ───────────────────────────────────────────────────────────

  it('filters to only runpod when providerFilter="runpod" and all keys set', () => {
    const result = buildProviderQueries({
      runpodApiKey: 'rp_key',
      vastApiKey: 'vast_key',
      tensordockApiKey: 'td_key',
      tensordockAuthId: 'td_auth',
      modalApiKey: 'modal_key',
      providerFilter: 'runpod',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('runpod');
  });

  it('filters to only vast when providerFilter="vast"', () => {
    const result = buildProviderQueries({
      runpodApiKey: 'rp_key',
      vastApiKey: 'vast_key',
      providerFilter: 'vast',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('vast');
  });

  it('filters to only tensordock when providerFilter="tensordock"', () => {
    const result = buildProviderQueries({
      runpodApiKey: 'rp_key',
      tensordockApiKey: 'td_key',
      tensordockAuthId: 'td_auth',
      providerFilter: 'tensordock',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('tensordock');
  });

  it('filters to only modal when providerFilter="modal"', () => {
    const result = buildProviderQueries({
      runpodApiKey: 'rp_key',
      modalApiKey: 'modal_key',
      providerFilter: 'modal',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('modal');
  });

  it('returns empty when providerFilter matches a provider that has no credentials', () => {
    const result = buildProviderQueries({
      runpodApiKey: 'rp_key',
      providerFilter: 'vast',   // vast key not provided
    });
    expect(result).toEqual([]);
  });

  it('returns empty when providerFilter is an unknown provider name', () => {
    const result = buildProviderQueries({
      runpodApiKey: 'rp_key',
      vastApiKey: 'vast_key',
      providerFilter: 'nonexistent',
    });
    expect(result).toEqual([]);
  });

  // ── Credential passthrough ────────────────────────────────────────────────────

  it('passes the exact runpodApiKey as credentials.apiKey', () => {
    const key = 'rpa_unique_key_value';
    const result = buildProviderQueries({ runpodApiKey: key });
    expect(result[0].credentials.apiKey).toBe(key);
  });

  it('passes the exact vastApiKey as credentials.apiKey', () => {
    const key = 'abcdef1234567890';
    const result = buildProviderQueries({ vastApiKey: key });
    expect(result[0].credentials.apiKey).toBe(key);
  });

  it('tensordock credentials include both apiKey and authId', () => {
    const result = buildProviderQueries({
      tensordockApiKey: 'td_key_xyz',
      tensordockAuthId: 'auth_id_xyz',
    });
    expect(result[0].credentials).toEqual({ apiKey: 'td_key_xyz', authId: 'auth_id_xyz' });
  });

  it('passes the exact modalApiKey as credentials.apiKey', () => {
    const key = 'modal_token_id:modal_token_secret';
    const result = buildProviderQueries({ modalApiKey: key });
    expect(result[0].credentials.apiKey).toBe(key);
  });

  // ── Client identity ───────────────────────────────────────────────────────────

  it('each entry references the correct provider client object', () => {
    const result = buildProviderQueries({
      runpodApiKey: 'rp_key',
      vastApiKey: 'vast_key',
      tensordockApiKey: 'td_key',
      tensordockAuthId: 'td_auth',
      modalApiKey: 'modal_key',
    });
    const byName = Object.fromEntries(result.map(r => [r.name, r]));
    expect(byName.runpod.client).toBe(mockProviders.runpod);
    expect(byName.vast.client).toBe(mockProviders.vast);
    expect(byName.tensordock.client).toBe(mockProviders.tensordock);
    expect(byName.modal.client).toBe(mockProviders.modal);
  });

  // ── Mixed: some providers configured, some not ───────────────────────────────

  it('returns only providers with valid credentials when a subset is configured', () => {
    const result = buildProviderQueries({
      runpodApiKey: 'rp_key',
      // vast not configured
      tensordockApiKey: 'td_key',
      tensordockAuthId: 'td_auth',
      // modal not configured
    });
    expect(result).toHaveLength(2);
    expect(result.map(q => q.name)).toEqual(['runpod', 'tensordock']);
  });

  it('omits tensordock but includes other providers when tensordockApiKey is missing', () => {
    const result = buildProviderQueries({
      runpodApiKey: 'rp_key',
      tensordockAuthId: 'td_auth',   // missing tensordockApiKey — should be skipped
      vastApiKey: 'vast_key',
    });
    expect(result.map(q => q.name)).toEqual(['runpod', 'vast']);
  });

  // ── Filter combined with missing credentials ──────────────────────────────────

  it('returns empty when providerFilter="tensordock" but only tensordockAuthId set (missing apiKey)', () => {
    const result = buildProviderQueries({
      tensordockAuthId: 'td_auth',
      providerFilter: 'tensordock',
    });
    expect(result).toEqual([]);
  });
});
