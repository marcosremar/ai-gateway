/**
 * temperature-router — Phase 2.
 *
 * Covers tier ordering, dedup, and the wakeSlot contract across T0/T1/T2.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  pickHottestSlot,
  wakeSlot,
  type PoolSlot,
  type SshExec,
} from '../src/gateway/autoscaler/temperature-router';

function mkSlot(overrides: Partial<PoolSlot>): PoolSlot {
  return {
    vmId: 'vm',
    endpoint: 'http://vm',
    sshHost: '1.2.3.4',
    sshPort: 22,
    tier: 'T0_warm',
    lastRequestAt: 0,
    ...overrides,
  };
}

describe('pickHottestSlot', () => {
  it('returns null for an empty list', () => {
    expect(pickHottestSlot([])).toEqual({ slot: null, estimatedWakeMs: 0 });
  });

  it('prefers T0 over T1 and T2', () => {
    const t0 = mkSlot({ vmId: 'a', tier: 'T0_warm', lastRequestAt: 1_000 });
    const t1 = mkSlot({ vmId: 'b', tier: 'T1_offloaded', lastRequestAt: 0 });
    const t2 = mkSlot({ vmId: 'c', tier: 'T2_stopped', lastRequestAt: 0 });
    const { slot, estimatedWakeMs } = pickHottestSlot([t2, t1, t0]);
    expect(slot?.vmId).toBe('a');
    expect(estimatedWakeMs).toBe(0);
  });

  it('picks least-recently-used within the same tier', () => {
    const older = mkSlot({ vmId: 'old', tier: 'T1_offloaded', lastRequestAt: 10 });
    const newer = mkSlot({ vmId: 'new', tier: 'T1_offloaded', lastRequestAt: 999 });
    const { slot, estimatedWakeMs } = pickHottestSlot([newer, older]);
    expect(slot?.vmId).toBe('old');
    expect(estimatedWakeMs).toBe(1_300);
  });
});

describe('wakeSlot', () => {
  it('no-ops on a T0 slot', async () => {
    const ssh: SshExec = vi.fn(async () => '');
    const slot = mkSlot({ tier: 'T0_warm' });
    await wakeSlot(slot, ssh);
    expect(ssh).not.toHaveBeenCalled();
    expect(slot.tier).toBe('T0_warm');
  });

  it('wakes a T1 slot via ssh and flips tier to T0', async () => {
    const ssh: SshExec = vi.fn(async () => '');
    const slot = mkSlot({ tier: 'T1_offloaded' });
    await wakeSlot(slot, ssh);
    expect(ssh).toHaveBeenCalledTimes(1);
    expect(slot.tier).toBe('T0_warm');
  });

  it('dedupes concurrent wakes of the same T1 slot', async () => {
    let resolveSsh: (v: string) => void = () => {};
    const ssh: SshExec = vi.fn(
      () => new Promise<string>((res) => { resolveSsh = res; }),
    );
    const slot = mkSlot({ tier: 'T1_offloaded' });
    const p1 = wakeSlot(slot, ssh);
    const p2 = wakeSlot(slot, ssh);
    expect(ssh).toHaveBeenCalledTimes(1);
    resolveSsh('');
    await Promise.all([p1, p2]);
    expect(ssh).toHaveBeenCalledTimes(1);
    expect(slot.tier).toBe('T0_warm');
  });

  it('throws for T2 (requires pool manager)', async () => {
    const slot = mkSlot({ tier: 'T2_stopped' });
    await expect(wakeSlot(slot)).rejects.toThrow(/requires pool manager/);
  });

  it('throws for T4 (requires pool manager)', async () => {
    const slot = mkSlot({ tier: 'T4_cold' });
    await expect(wakeSlot(slot)).rejects.toThrow(/requires pool manager/);
  });
});
