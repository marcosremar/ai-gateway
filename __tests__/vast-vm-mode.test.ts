/**
 * Phase B6 — VastVmClient runtype and search-body augmentation.
 *
 * We can't easily observe the body VastClient sends without massive
 * mocking, but we can verify that:
 *   - VastVmClient exposes providerId='vast-vm'.
 *   - VastVmClient's protected _runtype is 'vm' (via subclass access).
 *   - _augmentOfferSearch inserts vms_enabled={eq:true} and drops
 *     direct_port_count.
 */
import { describe, it, expect } from 'vitest';
import { VastVmClient } from '../src/gpu-providers/vast-vm';

class SpyClient extends VastVmClient {
  public inspect(searchBody: Record<string, unknown>): void {
    // @ts-expect-error — calling protected method for test visibility.
    this._augmentOfferSearch(searchBody, {});
  }
  public getRuntype(): string {
    // @ts-expect-error — protected field
    return this._runtype;
  }
}

describe('VastVmClient', () => {
  it('providerId is vast-vm', () => {
    const c = new VastVmClient();
    expect(c.providerId).toBe('vast-vm');
  });

  it('uses runtype vm (different from VastClient default)', () => {
    const c = new SpyClient();
    expect(c.getRuntype()).toBe('vm');
  });

  it('augments offer search with vms_enabled and removes direct_port_count', () => {
    const body: Record<string, unknown> = { direct_port_count: { gte: 1 } };
    const c = new SpyClient();
    c.inspect(body);
    expect(body.vms_enabled).toEqual({ eq: true });
    expect(body.direct_port_count).toBeUndefined();
  });
});
