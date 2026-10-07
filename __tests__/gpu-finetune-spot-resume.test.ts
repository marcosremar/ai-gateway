import { describe, it, expect } from 'vitest';
import {
  isEvictionError,
  attemptSpendUsd,
  addAttempt,
  emptyBudget,
  decideRetry,
  deriveJobId,
} from '../src/gpu-finetune/spot-resume';

describe('spot-resume: isEvictionError', () => {
  it('flags transient pod-death / preemption signatures', () => {
    for (const m of [
      'ssh exited with exit code: 255',
      'SSH proxy unreachable',
      'rsync upload failed after 8 attempts',
      'Connection refused',
      'boot timed out after 10min',
      '[gpu] vast instance GPU disassociated (hostnode reclaimed GPU)',
      'instance exited',
      'spot instance was preempted',
      'connection reset by peer',
      'host unreachable',
    ]) {
      expect(isEvictionError(m), m).toBe(true);
    }
  });

  it('does NOT flag real training errors', () => {
    for (const m of [
      'AssertionError: loss is NaN',
      'ModuleNotFoundError: no module named pocket_tts',
      'ValueError: shape mismatch',
      'KeyError: latents',
      '',
    ]) {
      expect(isEvictionError(m), m).toBe(false);
    }
  });
});

describe('spot-resume: attemptSpendUsd', () => {
  it('computes pricePerHr × hours', () => {
    const s = attemptSpendUsd({ pricePerHr: 0.30, startedAt: '2026-05-29T00:00:00Z', endedAt: '2026-05-29T02:00:00Z' });
    expect(s).toBeCloseTo(0.60, 6); // 2h × $0.30
  });
  it('returns 0 for non-positive duration or bad inputs', () => {
    expect(attemptSpendUsd({ pricePerHr: 1, startedAt: '2026-05-29T02:00:00Z', endedAt: '2026-05-29T01:00:00Z' })).toBe(0);
    expect(attemptSpendUsd({ pricePerHr: 1, startedAt: 'nonsense', endedAt: '2026-05-29T01:00:00Z' })).toBe(0);
    expect(attemptSpendUsd({ pricePerHr: -5, startedAt: '2026-05-29T00:00:00Z', endedAt: '2026-05-29T01:00:00Z' })).toBe(0);
  });
});

describe('spot-resume: budget accumulation', () => {
  it('accumulates across attempts, rounds to cents, clamps negatives', () => {
    let b = emptyBudget('jobs/x', '2026-05-29T00:00:00Z');
    expect(b).toMatchObject({ jobId: 'jobs/x', totalSpentUsd: 0, attempts: 0 });
    b = addAttempt(b, 0.333, '2026-05-29T01:00:00Z');
    b = addAttempt(b, 0.111, '2026-05-29T02:00:00Z');
    b = addAttempt(b, -9, '2026-05-29T03:00:00Z'); // clamped to 0
    expect(b.totalSpentUsd).toBeCloseTo(0.44, 6);
    expect(b.attempts).toBe(3);
    expect(b.updatedAt).toBe('2026-05-29T03:00:00Z');
  });
});

describe('spot-resume: decideRetry', () => {
  const base = { attempt: 1, maxAttempts: 5, totalSpentUsd: 0, maxSpend: 10 };
  it('retries on eviction within budget + attempts', () => {
    const d = decideRetry({ ...base, isEviction: true });
    expect(d.retry).toBe(true);
  });
  it('stops on non-eviction error', () => {
    expect(decideRetry({ ...base, isEviction: false }).retry).toBe(false);
  });
  it('stops when cumulative spend reached budget', () => {
    const d = decideRetry({ ...base, isEviction: true, totalSpentUsd: 10, maxSpend: 10 });
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/budget/);
  });
  it('stops at max attempts', () => {
    const d = decideRetry({ ...base, isEviction: true, attempt: 5, maxAttempts: 5 });
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/max attempts/);
  });
  it('maxSpend<=0 means no spend cap (only attempts cap)', () => {
    const d = decideRetry({ ...base, isEviction: true, totalSpentUsd: 9999, maxSpend: 0 });
    expect(d.retry).toBe(true);
  });
});

describe('spot-resume: deriveJobId', () => {
  it('prefers explicit r2Prefix, strips trailing slashes', () => {
    expect(deriveJobId({ r2Prefix: 'jobs/my-run/' })).toBe('jobs/my-run');
  });
  it('falls back to project then type', () => {
    expect(deriveJobId({ project: 'tts-ptbr' })).toBe('jobs/tts-ptbr');
    expect(deriveJobId({ type: 'audio' })).toBe('jobs/audio');
    expect(deriveJobId({})).toBe('jobs/finetune');
  });
});
