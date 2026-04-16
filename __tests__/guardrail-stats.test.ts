/**
 * Guardrail Stats Registry — unit tests
 *
 * Covers the singleton stats module that tracks how many requests
 * passed, were blocked, or audited by the GuardrailEngine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordGuardrailPass,
  recordGuardrailBlock,
  recordGuardrailAudit,
  getGuardrailStats,
  resetGuardrailStats,
} from '../src/gateway/guardrails/stats';

// Always reset before each test to isolate state
beforeEach(() => {
  resetGuardrailStats();
});

// ── reset ────────────────────────────────────────────────────────────────────

describe('resetGuardrailStats', () => {
  it('zeroes all counters', () => {
    recordGuardrailPass();
    recordGuardrailBlock('regex');
    resetGuardrailStats();
    const s = getGuardrailStats();
    expect(s.passed).toBe(0);
    expect(s.blocked).toBe(0);
    expect(s.audited).toBe(0);
    expect(s.totalEvaluations).toBe(0);
    expect(s.ruleHits).toEqual({});
    expect(s.lastBlockedAt).toBeNull();
  });
});

// ── recordGuardrailPass ───────────────────────────────────────────────────────

describe('recordGuardrailPass', () => {
  it('increments passed and totalEvaluations', () => {
    recordGuardrailPass();
    recordGuardrailPass();
    const s = getGuardrailStats();
    expect(s.passed).toBe(2);
    expect(s.totalEvaluations).toBe(2);
    expect(s.blocked).toBe(0);
    expect(s.audited).toBe(0);
  });

  it('does not set lastBlockedAt', () => {
    recordGuardrailPass();
    expect(getGuardrailStats().lastBlockedAt).toBeNull();
  });

  it('does not add to ruleHits', () => {
    recordGuardrailPass();
    expect(getGuardrailStats().ruleHits).toEqual({});
  });
});

// ── recordGuardrailBlock ──────────────────────────────────────────────────────

describe('recordGuardrailBlock', () => {
  it('increments blocked and totalEvaluations', () => {
    recordGuardrailBlock('regex');
    const s = getGuardrailStats();
    expect(s.blocked).toBe(1);
    expect(s.totalEvaluations).toBe(1);
    expect(s.passed).toBe(0);
  });

  it('records ruleHits per type', () => {
    recordGuardrailBlock('regex');
    recordGuardrailBlock('regex');
    recordGuardrailBlock('jsonSchema');
    const s = getGuardrailStats();
    expect(s.ruleHits['regex']).toBe(2);
    expect(s.ruleHits['jsonSchema']).toBe(1);
  });

  it('sets lastBlockedAt to a recent timestamp', () => {
    const before = Date.now();
    recordGuardrailBlock('notNull');
    const after = Date.now();
    const s = getGuardrailStats();
    expect(s.lastBlockedAt).not.toBeNull();
    expect(s.lastBlockedAt!).toBeGreaterThanOrEqual(before);
    expect(s.lastBlockedAt!).toBeLessThanOrEqual(after);
  });

  it('updates lastBlockedAt on each block', () => {
    recordGuardrailBlock('regex');
    const first = getGuardrailStats().lastBlockedAt;
    recordGuardrailBlock('modelWhitelist');
    const second = getGuardrailStats().lastBlockedAt;
    expect(second).toBeGreaterThanOrEqual(first!);
  });
});

// ── recordGuardrailAudit ──────────────────────────────────────────────────────

describe('recordGuardrailAudit', () => {
  it('increments audited and totalEvaluations', () => {
    recordGuardrailAudit('containsCode');
    const s = getGuardrailStats();
    expect(s.audited).toBe(1);
    expect(s.totalEvaluations).toBe(1);
    expect(s.blocked).toBe(0);
  });

  it('records ruleHits without setting lastBlockedAt', () => {
    recordGuardrailAudit('webhook');
    const s = getGuardrailStats();
    expect(s.ruleHits['webhook']).toBe(1);
    expect(s.lastBlockedAt).toBeNull();
  });

  it('accumulates multiple rule types', () => {
    recordGuardrailAudit('regex');
    recordGuardrailAudit('regex');
    recordGuardrailAudit('notNull');
    const s = getGuardrailStats();
    expect(s.ruleHits['regex']).toBe(2);
    expect(s.ruleHits['notNull']).toBe(1);
    expect(s.audited).toBe(3);
  });
});

// ── getGuardrailStats ─────────────────────────────────────────────────────────

describe('getGuardrailStats', () => {
  it('returns a snapshot (not a live reference)', () => {
    recordGuardrailPass();
    const snap1 = getGuardrailStats();
    recordGuardrailBlock('regex');
    const snap2 = getGuardrailStats();
    // snap1 should not be mutated by the second record
    expect(snap1.passed).toBe(1);
    expect(snap1.blocked).toBe(0);
    expect(snap2.passed).toBe(1);
    expect(snap2.blocked).toBe(1);
  });

  it('ruleHits is a copy — mutating it does not affect internal state', () => {
    recordGuardrailBlock('regex');
    const snap = getGuardrailStats();
    snap.ruleHits['regex'] = 999;
    expect(getGuardrailStats().ruleHits['regex']).toBe(1);
  });

  it('totalEvaluations is the sum of all actions', () => {
    recordGuardrailPass();
    recordGuardrailPass();
    recordGuardrailBlock('regex');
    recordGuardrailAudit('notNull');
    const s = getGuardrailStats();
    expect(s.totalEvaluations).toBe(4);
    expect(s.passed + s.blocked + s.audited).toBe(4);
  });
});

// ── mixed scenarios ───────────────────────────────────────────────────────────

describe('mixed scenarios', () => {
  it('handles high volume correctly', () => {
    for (let i = 0; i < 100; i++) recordGuardrailPass();
    for (let i = 0; i < 30; i++) recordGuardrailBlock('regex');
    for (let i = 0; i < 20; i++) recordGuardrailBlock('jsonSchema');
    for (let i = 0; i < 10; i++) recordGuardrailAudit('webhook');

    const s = getGuardrailStats();
    expect(s.passed).toBe(100);
    expect(s.blocked).toBe(50);
    expect(s.audited).toBe(10);
    expect(s.totalEvaluations).toBe(160);
    expect(s.ruleHits['regex']).toBe(30);
    expect(s.ruleHits['jsonSchema']).toBe(20);
    expect(s.ruleHits['webhook']).toBe(10);
  });

  it('reset clears everything between runs', () => {
    recordGuardrailBlock('modelWhitelist');
    resetGuardrailStats();
    recordGuardrailPass();
    const s = getGuardrailStats();
    expect(s.blocked).toBe(0);
    expect(s.passed).toBe(1);
    expect(s.ruleHits).toEqual({});
  });
});
