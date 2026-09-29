/**
 * Tests for normalizeInstanceStatus — shared GPU/CPU instance status vocabulary.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeInstanceStatus,
  type InstanceStatus,
} from '../src/gateway/providers/gpu/instance-status';

describe('normalizeInstanceStatus', () => {
  it('maps nullish / empty to unknown', () => {
    expect(normalizeInstanceStatus(null)).toBe('unknown');
    expect(normalizeInstanceStatus(undefined)).toBe('unknown');
    expect(normalizeInstanceStatus('')).toBe('unknown');
    expect(normalizeInstanceStatus('   ')).toBe('unknown');
  });

  it.each([
    ['RUNNING', 'running'],
    ['running', 'running'],
    ['started', 'running'],
    ['SUCCESS', 'running'],
    ['active', 'running'],
    ['deployed', 'running'],
  ] as const)('maps %s → %s', (raw, expected) => {
    expect(normalizeInstanceStatus(raw)).toBe(expected);
  });

  it.each([
    ['CREATING', 'booting'],
    ['starting', 'booting'],
    ['pending', 'booting'],
    ['provisioning', 'booting'],
    ['BUILDING', 'booting'],
    ['DEPLOYING', 'booting'],
    ['deploying', 'booting'],
    ['loading', 'booting'],
  ] as const)('maps %s → %s', (raw, expected) => {
    expect(normalizeInstanceStatus(raw)).toBe(expected);
  });

  it.each([
    ['EXITED', 'stopped'],
    ['stopped', 'stopped'],
    ['destroyed', 'stopped'],
    ['REMOVED', 'stopped'],
    ['offline', 'stopped'],
  ] as const)('maps %s → %s', (raw, expected) => {
    expect(normalizeInstanceStatus(raw)).toBe(expected);
  });

  it.each([
    ['FAILED', 'error'],
    ['CRASHED', 'error'],
    ['error', 'error'],
  ] as const)('maps %s → %s', (raw, expected) => {
    expect(normalizeInstanceStatus(raw)).toBe(expected);
  });

  it('returns unknown for unrecognized values', () => {
    expect(normalizeInstanceStatus('idle')).toBe('unknown');
    expect(normalizeInstanceStatus('weird-state')).toBe('unknown');
    expect(normalizeInstanceStatus('QUEUED')).toBe('unknown');
  });

  it('only returns values from InstanceStatus union', () => {
    const allowed: InstanceStatus[] = ['running', 'booting', 'stopped', 'error', 'unknown'];
    for (const raw of ['RUNNING', 'CREATING', 'EXITED', 'FAILED', 'nope', null]) {
      expect(allowed).toContain(normalizeInstanceStatus(raw));
    }
  });
});
