/**
 * Bug: dailyGpuSpendUsd was only reset at the UTC day boundary inside
 * gpu-monitor-loop's `if (deployState.costPerHr > 0)` block — i.e. only when a
 * GLOBAL deploy is billing. Since every deploy now lands in a per-caller slot
 * (accrued by gpu-telemetry's 60s tick), a long-running slot-only gateway never
 * reset its "daily" spend, so it grew monotonically across days until
 * canAffordDeploy()'s soft limit refused all deploys permanently.
 *
 * Fix: rolloverDailySpendIfNewDay() is the single shared reset, called
 * unconditionally from the telemetry accrual tick (and the monitor loop).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as cost from '../../src/gateway/state/cost-state';

const today = () => new Date().toISOString().slice(0, 10);

afterEach(() => {
  cost.setDailyGpuSpendUsd(0);
  cost.setDailySpendResetDate(today());
  cost.flushDailySpend();
});

describe('rolloverDailySpendIfNewDay', () => {
  it('zeroes the counter and advances the date when the day changed', () => {
    cost.setDailySpendResetDate('2026-06-24');
    cost.setDailyGpuSpendUsd(42.5);
    expect(cost.rolloverDailySpendIfNewDay('2026-06-25')).toBe(true);
    expect(cost.dailyGpuSpendUsd).toBe(0);
    expect(cost.dailySpendResetDate).toBe('2026-06-25');
  });

  it('is a no-op within the same day (does not wipe mid-day spend)', () => {
    cost.setDailySpendResetDate('2026-06-25');
    cost.setDailyGpuSpendUsd(42.5);
    expect(cost.rolloverDailySpendIfNewDay('2026-06-25')).toBe(false);
    expect(cost.dailyGpuSpendUsd).toBe(42.5);
  });

  it('accumulates within a day and resets only on the flip (telemetry tick pattern)', () => {
    cost.setDailySpendResetDate('2026-06-24');
    cost.setDailyGpuSpendUsd(0);
    for (const add of [10, 10, 10]) {
      expect(cost.rolloverDailySpendIfNewDay('2026-06-24')).toBe(false);
      cost.setDailyGpuSpendUsd(cost.dailyGpuSpendUsd + add);
    }
    expect(cost.dailyGpuSpendUsd).toBe(30);
    expect(cost.rolloverDailySpendIfNewDay('2026-06-25')).toBe(true);
    expect(cost.dailyGpuSpendUsd).toBe(0);
  });
});
