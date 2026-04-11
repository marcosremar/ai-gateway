import { describe, it, expect, vi } from 'vitest';
import { SnapgpuMetrics, buildWorkloadKey } from '../src/autoscaler/snapgpu-metrics';

// ── buildWorkloadKey ────────────────────────────────────────────────────────

describe('buildWorkloadKey', () => {
  it('combines image and app name', () => {
    expect(buildWorkloadKey('img:v1', 'whisper')).toBe('img:v1::whisper');
  });

  it('fills in defaults for missing parts', () => {
    expect(buildWorkloadKey(undefined, undefined)).toBe('unknown-image::default');
    expect(buildWorkloadKey('img:v1', undefined)).toBe('img:v1::default');
  });

  it('returns distinct keys when image changes', () => {
    expect(buildWorkloadKey('img:v1', 'app')).not.toBe(buildWorkloadKey('img:v2', 'app'));
  });
});

// ── SnapgpuMetrics ──────────────────────────────────────────────────────────

describe('SnapgpuMetrics', () => {
  const USER = 'u1';
  const KEY = 'image:v1::default';

  it('returns null stats for unknown workload', () => {
    const m = new SnapgpuMetrics();
    expect(m.stats(USER, KEY)).toBeNull();
  });

  it('records observations and reports rolling averages', () => {
    const m = new SnapgpuMetrics();
    m.record(USER, KEY, 'cold', 40000);
    m.record(USER, KEY, 'cold', 50000);
    m.record(USER, KEY, 'restore', 5000);
    m.record(USER, KEY, 'restore', 6000);

    const s = m.stats(USER, KEY)!;
    expect(s.coldAvgMs).toBe(45000);
    expect(s.restoreAvgMs).toBe(5500);
    expect(s.coldCount).toBe(2);
    expect(s.restoreCount).toBe(2);
  });

  it('drops the oldest observation when window is full', () => {
    const m = new SnapgpuMetrics({ windowSize: 3 });
    m.record(USER, KEY, 'cold', 1000);
    m.record(USER, KEY, 'cold', 2000);
    m.record(USER, KEY, 'cold', 3000);
    m.record(USER, KEY, 'cold', 4000);

    const s = m.stats(USER, KEY)!;
    // Window dropped the 1000ms observation — avg of 2000+3000+4000 = 3000
    expect(s.coldCount).toBe(3);
    expect(s.coldAvgMs).toBe(3000);
  });

  it('does not record zero or negative durations', () => {
    const m = new SnapgpuMetrics();
    m.record(USER, KEY, 'cold', 0);
    m.record(USER, KEY, 'cold', -100);
    expect(m.stats(USER, KEY)).toBeNull();
  });

  it('does not record when workloadKey is empty', () => {
    const m = new SnapgpuMetrics();
    m.record(USER, '', 'cold', 1000);
    expect(m.stats(USER, '')).toBeNull();
  });
});

// ── Auto-disable ─────────────────────────────────────────────────────────────

describe('SnapgpuMetrics — auto-disable', () => {
  const USER = 'u1';
  const KEY = 'image:v1::default';

  it('does not disable when sample count is below minSamples', () => {
    const m = new SnapgpuMetrics({ minSamples: 3 });
    // Only one cold, one restore — below minSamples
    m.record(USER, KEY, 'cold', 30000);
    m.record(USER, KEY, 'restore', 50000);
    expect(m.isDisabled(USER, KEY)).toBe(false);
  });

  it('auto-disables when restore is consistently slower than cold × disableRatio', () => {
    // disableRatio=0.7 → restore must be ≤ 70% of cold to stay enabled.
    // Here restore=50000, cold=30000 → 50000 > 30000 × 0.7 = 21000, DISABLE.
    const m = new SnapgpuMetrics({ minSamples: 3, disableRatio: 0.7 });
    m.record(USER, KEY, 'cold', 30000);
    m.record(USER, KEY, 'cold', 30000);
    m.record(USER, KEY, 'cold', 30000);
    m.record(USER, KEY, 'restore', 50000);
    m.record(USER, KEY, 'restore', 50000);
    m.record(USER, KEY, 'restore', 50000);
    expect(m.isDisabled(USER, KEY)).toBe(true);
  });

  it('keeps enabled when restore is faster than cold by enough margin', () => {
    // cold=45000, restore=8000 → 8000 < 45000 × 0.7 = 31500, KEEP ENABLED.
    const m = new SnapgpuMetrics({ minSamples: 3, disableRatio: 0.7 });
    m.record(USER, KEY, 'cold', 45000);
    m.record(USER, KEY, 'cold', 45000);
    m.record(USER, KEY, 'cold', 45000);
    m.record(USER, KEY, 'restore', 8000);
    m.record(USER, KEY, 'restore', 8000);
    m.record(USER, KEY, 'restore', 8000);
    expect(m.isDisabled(USER, KEY)).toBe(false);
  });

  it('fires the onDisable listener with cold/restore averages and reason', () => {
    const events: Array<{ userId: string; workloadKey: string; avgColdMs: number; avgRestoreMs: number }> = [];
    const m = new SnapgpuMetrics({ minSamples: 3, disableRatio: 0.7 });
    m.onDisable(e => events.push(e));

    for (let i = 0; i < 3; i++) m.record(USER, KEY, 'cold', 30000);
    for (let i = 0; i < 3; i++) m.record(USER, KEY, 'restore', 50000);

    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe(USER);
    expect(events[0].workloadKey).toBe(KEY);
    expect(events[0].avgColdMs).toBe(30000);
    expect(events[0].avgRestoreMs).toBe(50000);
  });

  it('does not refire onDisable while sticky TTL is still in effect', () => {
    const listener = vi.fn();
    const m = new SnapgpuMetrics({ minSamples: 3, disableRatio: 0.7, disableTtlMs: 1_000_000 });
    m.onDisable(listener);

    for (let i = 0; i < 3; i++) m.record(USER, KEY, 'cold', 30000);
    for (let i = 0; i < 3; i++) m.record(USER, KEY, 'restore', 50000);
    expect(listener).toHaveBeenCalledTimes(1);

    // Recording more observations while disabled — should NOT re-evaluate
    m.record(USER, KEY, 'restore', 60000);
    m.record(USER, KEY, 'restore', 70000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('re-enables after the disable TTL expires', () => {
    let now = 1000;
    const m = new SnapgpuMetrics({
      minSamples: 3,
      disableRatio: 0.7,
      disableTtlMs: 1000,
      now: () => now,
    });

    for (let i = 0; i < 3; i++) m.record(USER, KEY, 'cold', 30000);
    for (let i = 0; i < 3; i++) m.record(USER, KEY, 'restore', 50000);
    expect(m.isDisabled(USER, KEY)).toBe(true);

    now += 2000; // past TTL
    expect(m.isDisabled(USER, KEY)).toBe(false);
  });

  it('manual disable() takes effect immediately and fires the listener', () => {
    const listener = vi.fn();
    const m = new SnapgpuMetrics();
    m.onDisable(listener);

    m.disable(USER, KEY, 'criu_not_available_on_host');
    expect(m.isDisabled(USER, KEY)).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER,
      workloadKey: KEY,
      reason: 'criu_not_available_on_host',
    }));
  });

  it('manual disable respects a custom TTL', () => {
    let now = 1000;
    const m = new SnapgpuMetrics({ now: () => now, disableTtlMs: 99999999 });
    m.disable(USER, KEY, 'test', 500);
    expect(m.isDisabled(USER, KEY)).toBe(true);
    now += 600;
    expect(m.isDisabled(USER, KEY)).toBe(false);
  });
});

// ── Isolation ────────────────────────────────────────────────────────────────

describe('SnapgpuMetrics — isolation', () => {
  it('keeps state separate across users', () => {
    const m = new SnapgpuMetrics({ minSamples: 3, disableRatio: 0.7 });
    for (let i = 0; i < 3; i++) m.record('u1', 'img::app', 'cold', 30000);
    for (let i = 0; i < 3; i++) m.record('u1', 'img::app', 'restore', 50000);
    expect(m.isDisabled('u1', 'img::app')).toBe(true);
    expect(m.isDisabled('u2', 'img::app')).toBe(false);
  });

  it('keeps state separate across workloads', () => {
    const m = new SnapgpuMetrics({ minSamples: 3, disableRatio: 0.7 });
    for (let i = 0; i < 3; i++) m.record('u1', 'imgA::app', 'cold', 30000);
    for (let i = 0; i < 3; i++) m.record('u1', 'imgA::app', 'restore', 50000);
    expect(m.isDisabled('u1', 'imgA::app')).toBe(true);
    expect(m.isDisabled('u1', 'imgB::app')).toBe(false);
  });
});

// ── reset() ──────────────────────────────────────────────────────────────────

describe('SnapgpuMetrics.reset', () => {
  it('clears all state', () => {
    const m = new SnapgpuMetrics({ minSamples: 3, disableRatio: 0.7 });
    for (let i = 0; i < 3; i++) m.record('u1', 'img::app', 'cold', 30000);
    for (let i = 0; i < 3; i++) m.record('u1', 'img::app', 'restore', 50000);
    expect(m.isDisabled('u1', 'img::app')).toBe(true);

    m.reset();
    expect(m.isDisabled('u1', 'img::app')).toBe(false);
    expect(m.stats('u1', 'img::app')).toBeNull();
  });
});
