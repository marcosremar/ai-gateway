/**
 * P0-3: Cost watcher — soft alerts at 50%/80% of daily cap
 */

import { describe, it, expect, vi } from 'vitest';
import { CostWatcher, type CostAlertEvent } from '../src/alerting/cost-watcher';
import type { AlertRouter } from '../src/alerting/alert-router';
import type { AlertPayload } from '../src/alerting/types';

function makeFakeRouter() {
  const sent: AlertPayload[] = [];
  const router = {
    route: vi.fn(async (p: AlertPayload) => { sent.push(p); }),
  } as unknown as AlertRouter;
  return { router, sent };
}

describe('CostWatcher — threshold alerts', () => {
  const CAP = 50;

  it('does not alert below any threshold', () => {
    const { router, sent } = makeFakeRouter();
    const watcher = new CostWatcher({ router, cap: CAP });
    const fired = watcher.report(10); // 20% of cap
    expect(fired).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('alerts at 50% crossing', () => {
    const { router, sent } = makeFakeRouter();
    const watcher = new CostWatcher({ router, cap: CAP });
    const fired = watcher.report(25); // 50% exactly
    expect(fired).toEqual([0.5]);
    expect(sent).toHaveLength(1);
    expect(sent[0].severity).toBe('warning');
    expect(sent[0].title).toContain('50%');
  });

  it('alerts at 80% crossing with critical severity', () => {
    const { router, sent } = makeFakeRouter();
    const watcher = new CostWatcher({ router, cap: CAP });
    const fired = watcher.report(40); // 80%
    expect(fired).toEqual([0.5, 0.8]); // both thresholds fire on first report
    expect(sent).toHaveLength(2);
    expect(sent[1].severity).toBe('critical');
  });

  it('fires both thresholds when jumping from 0 to 90%', () => {
    // Edge case: spend can leap in the monitor loop. Both thresholds should
    // fire on the same report call, in order.
    const { router, sent } = makeFakeRouter();
    const watcher = new CostWatcher({ router, cap: CAP });
    const fired = watcher.report(45); // 90% — crosses both 50 and 80
    expect(fired).toEqual([0.5, 0.8]);
    expect(sent).toHaveLength(2);
  });

  it('does NOT re-alert when report is called again above the threshold', () => {
    const { router, sent } = makeFakeRouter();
    const watcher = new CostWatcher({ router, cap: CAP });
    watcher.report(25); // fires 50%
    watcher.report(30); // still above 50%, no new fire
    watcher.report(35); // still above 50%, no new fire
    expect(sent).toHaveLength(1);
  });

  it('fires 80% on the next report after 50% already fired', () => {
    const { router, sent } = makeFakeRouter();
    const watcher = new CostWatcher({ router, cap: CAP });
    watcher.report(25); // fires 50%
    watcher.report(45); // 90% — fires 80%
    expect(sent).toHaveLength(2);
    expect(sent[0].title).toContain('50%');
    expect(sent[1].title).toContain('80%');
  });
});

describe('CostWatcher — daily reset', () => {
  it('clears fired flags on date rollover', () => {
    let now = new Date('2026-04-12T23:59:00Z').getTime();
    const { router, sent } = makeFakeRouter();
    const watcher = new CostWatcher({ router, cap: 50, now: () => now });

    watcher.report(30); // fires 50%
    expect(sent).toHaveLength(1);
    expect(watcher.firedThresholds()).toEqual([0.5]);

    // Advance past midnight UTC
    now = new Date('2026-04-13T00:01:00Z').getTime();
    // Next day's first report should be able to fire 50% again
    watcher.report(30);
    expect(sent).toHaveLength(2);
  });
});

describe('CostWatcher — disabled cap', () => {
  it('never alerts when cap is 0', () => {
    const { router, sent } = makeFakeRouter();
    const watcher = new CostWatcher({ router, cap: 0 });
    expect(watcher.report(999_999)).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});

describe('CostWatcher — observability hook', () => {
  it('calls onEmit for every fired threshold', () => {
    const { router } = makeFakeRouter();
    const seen: CostAlertEvent[] = [];
    const watcher = new CostWatcher({
      router,
      cap: 50,
      onEmit: (e) => seen.push(e),
    });
    watcher.report(45); // crosses both
    expect(seen).toHaveLength(2);
    expect(seen[0].threshold).toBe(0.5);
    expect(seen[1].threshold).toBe(0.8);
    expect(seen[0].severity).toBe('warning');
    expect(seen[1].severity).toBe('critical');
  });
});

describe('CostWatcher — the 2026-03-25 scenario', () => {
  it('would have alerted at $25 during the $130 spike', () => {
    // Replay: spend climbs from 0 → 130 over a day on a $50 cap.
    const { router, sent } = makeFakeRouter();
    const watcher = new CostWatcher({ router, cap: 50 });

    // Monitor loop ticks observing increasing spend
    watcher.report(5);    // no alert
    watcher.report(15);   // no alert
    watcher.report(24);   // no alert (48%)
    watcher.report(26);   // ← 52%, fires 50% warning
    watcher.report(35);   // 70%, no new alert
    watcher.report(41);   // 82%, fires 80% critical
    watcher.report(80);   // still above both, no new alerts
    watcher.report(130);  // still above both, no new alerts

    // The operator would have seen two alerts: a 50% warning at $26 and
    // an 80% critical at $41. In the actual incident, they saw nothing
    // until the hard cap termination — and by then $130 was gone.
    expect(sent).toHaveLength(2);
    expect(sent[0].title).toContain('50%');
    expect(sent[1].title).toContain('80%');
    expect(sent[1].severity).toBe('critical');
  });
});
