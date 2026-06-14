/**
 * Optimization implementation tests — Observability, Metrics & Cost Tracking
 * WAVE 5 (audit IDs 501-600, docs/optimizations/06-observability-cost.md).
 *
 * A DISTINCT batch from waves 1-4. The safe/localized pool is nearly exhausted;
 * this wave closes the remaining *exposition* gaps — counters that already
 * existed on their module singletons but were never surfaced to /metrics — plus
 * the windowed SLO breach tracker that completes #598.
 *
 *   #525        gateway_cost_unmapped_total exported (+ snapshot field)
 *   #580        gateway_event_handler_errors_total exported
 *   #582        gateway_hook_errors_total exported
 *   #589        gateway_metrics_dropped_cardinality_total exported
 *   #598(cont.) SloBreachTracker — windowed breach count feeds breachAction so
 *               SLO_BREACH_POLICY's page/failover WINDOWS stop being dead config
 *
 * Unit-only. No network. Pure logic + in-memory singletons + injected clocks.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// #598 (continuation) — SloBreachTracker: windowed breach counting
// ─────────────────────────────────────────────────────────────────────────────

import {
  SloBreachTracker,
  evaluateSlos,
  breachAction,
  SLO_BREACH_POLICY,
  type SloBreach,
} from '../../src/alerting/slo-targets';

describe('#598 SloBreachTracker windows the breach count for breachAction', () => {
  it('escalates none → warn → page → failover as breaches accrue in-window', () => {
    let now = 1_000_000;
    const t = new SloBreachTracker({ now: () => now });

    expect(t.actionFor('chatP95Ms')).toBe('none');

    // 1 breach → warn (warningThreshold = 1)
    t.record('chatP95Ms', 3000, 2000);
    expect(t.recentCount('chatP95Ms')).toBe(1);
    expect(t.actionFor('chatP95Ms')).toBe('warn');

    // 2 in window → page (pageThreshold = 2)
    now += 1000;
    t.record('chatP95Ms', 3100, 2000);
    expect(t.actionFor('chatP95Ms')).toBe('page');

    // 5 in window → failover (failoverThreshold = 5)
    now += 1000; t.record('chatP95Ms', 3200, 2000);
    now += 1000; t.record('chatP95Ms', 3300, 2000);
    now += 1000; t.record('chatP95Ms', 3400, 2000);
    expect(t.recentCount('chatP95Ms')).toBe(5);
    expect(t.actionFor('chatP95Ms')).toBe('failover');
  });

  it('prunes breaches outside the failover window so old breaches do not escalate', () => {
    let now = 0;
    const t = new SloBreachTracker({ now: () => now });

    // Two breaches a long time ago.
    t.record('sttP95Ms', 2000, 1500);
    now += 1000;
    t.record('sttP95Ms', 2100, 1500);
    expect(t.actionFor('sttP95Ms')).toBe('page');

    // Advance past the failover window — the old breaches must fall out.
    now += SLO_BREACH_POLICY.failoverWindowMs + 1;
    expect(t.recentCount('sttP95Ms')).toBe(0);
    expect(t.actionFor('sttP95Ms')).toBe('none');
  });

  it('tracks metrics independently — one noisy SLO does not escalate another', () => {
    let now = 5_000;
    const t = new SloBreachTracker({ now: () => now });
    for (let i = 0; i < 5; i++) {
      now += 100;
      t.record('ttsP95Ms', 3000, 2500);
    }
    expect(t.actionFor('ttsP95Ms')).toBe('failover');
    expect(t.actionFor('chatP95Ms')).toBe('none');
    expect(t.recentCount('chatP95Ms')).toBe(0);
  });

  it('recordBreaches(evaluateSlos(...)) returns per-metric escalations in one step', () => {
    let now = 10_000;
    const t = new SloBreachTracker({ now: () => now });

    const breaches: SloBreach[] = evaluateSlos(
      { chatP95Ms: 5000, ttsP95Ms: 9000, healthP99Ms: 50 }, // healthP99 ok (50 < 200)
      {} as NodeJS.ProcessEnv,
    );
    // Two metrics breached (chat + tts); health is within target.
    expect(breaches.map((b) => b.metric).sort()).toEqual(['chatP95Ms', 'ttsP95Ms']);

    const esc1 = t.recordBreaches(breaches);
    expect(esc1.every((e) => e.action === 'warn')).toBe(true);
    expect(esc1.map((e) => e.metric).sort()).toEqual(['chatP95Ms', 'ttsP95Ms']);

    // A second identical evaluation pushes chat+tts to 2 → page.
    now += 1000;
    const esc2 = t.recordBreaches(breaches);
    for (const e of esc2) expect(e.action).toBe('page');
  });

  it('respects maxPerMetric so a sustained breach storm stays bounded', () => {
    let now = 0;
    const t = new SloBreachTracker({ now: () => now, maxPerMetric: 10 });
    for (let i = 0; i < 50; i++) {
      now += 1;
      t.record('chatP95Ms', 3000, 2000);
    }
    // Hard cap bounds retained entries even though all are in-window.
    expect(t.recentCount('chatP95Ms')).toBeLessThanOrEqual(10);
    // Still escalates (well past failoverThreshold).
    expect(t.actionFor('chatP95Ms')).toBe('failover');
  });

  it('clear() drops all tracked breaches', () => {
    const t = new SloBreachTracker();
    t.record('chatP95Ms', 3000, 2000);
    expect(t.actionFor('chatP95Ms')).toBe('warn');
    t.clear();
    expect(t.actionFor('chatP95Ms')).toBe('none');
  });

  it('breachAction thresholds are sourced from SLO_BREACH_POLICY', () => {
    expect(breachAction(0)).toBe('none');
    expect(breachAction(SLO_BREACH_POLICY.warningThreshold)).toBe('warn');
    expect(breachAction(SLO_BREACH_POLICY.pageThreshold)).toBe('page');
    expect(breachAction(SLO_BREACH_POLICY.failoverThreshold)).toBe('failover');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #525 / #580 / #582 / #589 — observability self-diagnostics now exported to
// /metrics. These read live module singletons, so the assertions are written to
// be order-independent (the opt suite shares a worker; other tests may have
// incremented these counters). We assert presence + correct exposition shape and
// monotonic deltas rather than absolute zero.
// ─────────────────────────────────────────────────────────────────────────────

import {
  renderPrometheusMetrics,
  getMetricsSnapshot,
} from '../../server/metrics';
import {
  recordInferenceCost,
  getInferenceCostStats,
  resetDailyInferenceCost,
} from '../../server/cost-tracker';

describe('#525 gateway_cost_unmapped_total surfaces $0-recorded requests', () => {
  it('snapshot.cost.unmappedRequests reflects unmapped provider:stage pairs', () => {
    resetDailyInferenceCost();
    const before = getInferenceCostStats().unmappedRequests;

    // A mapped pair (groq:stt) must NOT bump the unmapped counter.
    recordInferenceCost('groq', 'stt');
    // An unmapped pair (deepgram:stt is intentionally left unmapped) must.
    recordInferenceCost('deepgram', 'stt');
    recordInferenceCost('some-new-provider', 'llm');

    const snap = getMetricsSnapshot().cost as Record<string, unknown>;
    expect(typeof snap.unmappedRequests).toBe('number');
    expect((snap.unmappedRequests as number) - before).toBe(2);
  });

  it('renders gateway_cost_unmapped_total as a counter line', () => {
    const out = renderPrometheusMetrics();
    expect(out).toContain('# TYPE gateway_cost_unmapped_total counter');
    expect(out).toMatch(/gateway_cost_unmapped_total \d+/);
  });
});

describe('#580/#582/#589 observability self-diagnostics exported to /metrics', () => {
  it('snapshot.observability carries the three diagnostic counters', () => {
    const obs = getMetricsSnapshot().observability as Record<string, unknown>;
    expect(obs).toBeTruthy();
    expect(typeof obs.eventHandlerErrors).toBe('number');
    expect(typeof obs.hookErrors).toBe('number');
    expect(typeof obs.droppedCardinality).toBe('number');
  });

  it('exposes event-handler / hook / cardinality counters in Prometheus output', () => {
    const out = renderPrometheusMetrics();
    expect(out).toContain('# TYPE gateway_event_handler_errors_total counter');
    expect(out).toContain('# TYPE gateway_hook_errors_total counter');
    expect(out).toContain('# TYPE gateway_metrics_dropped_cardinality_total counter');
    expect(out).toMatch(/gateway_event_handler_errors_total \d+/);
    expect(out).toMatch(/gateway_hook_errors_total \d+/);
    expect(out).toMatch(/gateway_metrics_dropped_cardinality_total \d+/);
  });
});

// #580 — a throwing server event-bus handler increments the exported counter.
import {
  onGatewayEvent,
  emitGatewayEvent,
  handlerErrorCount,
} from '../../server/event-bus';

describe('#580 event-handler error counter increments and is reflected in /metrics', () => {
  it('a throwing handler bumps handlerErrorCount and the exported metric delta', () => {
    const before = handlerErrorCount();
    const beforeMetric = (getMetricsSnapshot().observability as { eventHandlerErrors: number }).eventHandlerErrors;

    const off = onGatewayEvent(() => {
      throw new Error('boom');
    });
    emitGatewayEvent('test.w5', { x: 1 });
    off();

    expect(handlerErrorCount() - before).toBe(1);
    const afterMetric = (getMetricsSnapshot().observability as { eventHandlerErrors: number }).eventHandlerErrors;
    expect(afterMetric - beforeMetric).toBe(1);
  });
});

// #582 — a throwing gateway hook increments the exported counter.
import {
  emitHook,
  getHookErrorCount,
  resetHookErrorCounts,
} from '../../src/events/hooks';

describe('#582 hook error counter increments and is reflected in /metrics', () => {
  it('a synchronously-throwing hook bumps getHookErrorCount and the metric', () => {
    resetHookErrorCounts();
    const beforeMetric = (getMetricsSnapshot().observability as { hookErrors: number }).hookErrors;

    emitHook(
      {
        onScaleUp: () => {
          throw new Error('hook boom');
        },
      },
      'onScaleUp',
      {
        userId: 'u1',
        tierIndex: 0,
        provider: 'runpod',
        trigger: 'test',
        activeSessions: 1,
        timestamp: Date.now(),
      },
    );

    expect(getHookErrorCount('onScaleUp')).toBe(1);
    const afterMetric = (getMetricsSnapshot().observability as { hookErrors: number }).hookErrors;
    expect(afterMetric - beforeMetric).toBe(1);
  });
});

// #589 — dropping a metric series past the cardinality cap is reflected in the
// exported gateway_metrics_dropped_cardinality_total.
import { metrics as metricsCollector } from '../../src/metrics-collector';

describe('#589 dropped-cardinality counter is reflected in /metrics', () => {
  beforeEach(() => metricsCollector.reset());

  it('series dropped past the cap increment the exported counter', () => {
    metricsCollector.setMaxSeriesPerMetric(2);
    metricsCollector.increment('w5.card', { id: 'a' });
    metricsCollector.increment('w5.card', { id: 'b' });
    // Third distinct label-set is over the cap → dropped + counted.
    metricsCollector.increment('w5.card', { id: 'c' });
    expect(metricsCollector.getDroppedCardinalityCount()).toBeGreaterThanOrEqual(1);

    const obs = getMetricsSnapshot().observability as { droppedCardinality: number };
    expect(obs.droppedCardinality).toBeGreaterThanOrEqual(1);

    const out = renderPrometheusMetrics();
    expect(out).toMatch(/gateway_metrics_dropped_cardinality_total \d+/);
    // The exported value must be >= what the collector reports right now.
    const m = out.match(/gateway_metrics_dropped_cardinality_total (\d+)/);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(1);
  });
});

// Defensive: snapshot must never throw even if a diagnostic source misbehaves.
describe('metrics snapshot is resilient to diagnostic reads', () => {
  it('getMetricsSnapshot()/renderPrometheusMetrics() do not throw', () => {
    expect(() => getMetricsSnapshot()).not.toThrow();
    expect(() => renderPrometheusMetrics()).not.toThrow();
  });
});
