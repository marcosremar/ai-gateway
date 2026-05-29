import { describe, it, expect } from 'vitest';
import {
  isProviderConfigured,
  computeProviderReadiness,
  filterUsableTiers,
} from '../src/modules/gpu-providers/provider-readiness';

describe('provider-readiness: isProviderConfigured', () => {
  it('vast/runpod/tensordock/hyperstack gated on their single key', () => {
    expect(isProviderConfigured('vast', { VAST_API_KEY: 'k' })).toBe(true);
    expect(isProviderConfigured('vast', {})).toBe(false);
    expect(isProviderConfigured('runpod', { RUNPOD_API_KEY: 'k' })).toBe(true);
    expect(isProviderConfigured('runpod', { RUNPOD_API_KEY: '  ' })).toBe(false); // blank = not set
    expect(isProviderConfigured('hyperstack', { HYPERSTACK_API_KEY: 'k' })).toBe(true);
  });

  it('modal accepts EITHER token var (OR groups)', () => {
    expect(isProviderConfigured('modal', { MODAL_TOKEN_ID: 'x' })).toBe(true);
    expect(isProviderConfigured('modal', { MODAL_API_KEY: 'x' })).toBe(true);
    expect(isProviderConfigured('modal', {})).toBe(false);
  });

  it('providers with no required creds default ready (snapgpu)', () => {
    expect(isProviderConfigured('snapgpu', {})).toBe(true);
  });
});

describe('provider-readiness: computeProviderReadiness', () => {
  it('reflects only the providers whose creds are present', () => {
    const r = computeProviderReadiness({ VAST_API_KEY: 'k' });
    expect(r.vast).toBe(true);
    expect(r['vast-vm']).toBe(true);
    expect(r.runpod).toBe(false);
    expect(r.modal).toBe(false);
    expect(r.snapgpu).toBe(true);
  });
});

describe('provider-readiness: filterUsableTiers', () => {
  const tier = (name: any) => ({ name, label: name });

  it('drops unconfigured providers, keeps configured', () => {
    const tiers = [tier('vast'), tier('runpod'), tier('modal')];
    const r = filterUsableTiers(tiers, { VAST_API_KEY: 'k' });
    expect(r.usable.map((t) => t.name)).toEqual(['vast']);
    expect(r.skipped.map((t) => t.name).sort()).toEqual(['modal', 'runpod']);
    expect(r.fellBack).toBe(false);
  });

  it('SAFE FALLBACK: never empties the race — returns original if all unconfigured', () => {
    const tiers = [tier('runpod'), tier('modal')];
    const r = filterUsableTiers(tiers, {}); // no creds at all
    expect(r.usable.map((t) => t.name)).toEqual(['runpod', 'modal']);
    expect(r.skipped).toEqual([]);
    expect(r.fellBack).toBe(true);
  });

  it('keeps all when all configured', () => {
    const tiers = [tier('vast'), tier('modal')];
    const r = filterUsableTiers(tiers, { VAST_API_KEY: 'k', MODAL_TOKEN_ID: 't' });
    expect(r.usable).toHaveLength(2);
    expect(r.fellBack).toBe(false);
  });
});
