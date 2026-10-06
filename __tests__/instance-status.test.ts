/**
 * Tests for normalizeInstanceStatus — shared GPU/CPU instance status vocabulary.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeInstanceStatus,
  isTerminalInstanceStatus,
  isBillableInstanceStatus,
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
    ['booting', 'booting'], // canonical identity
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

  it('maps idle → running (Vast endpoint with 0 workers)', () => {
    expect(normalizeInstanceStatus('idle')).toBe('running');
  });

  it('returns unknown for unrecognized values', () => {
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

describe('isTerminalInstanceStatus / isBillableInstanceStatus', () => {
  it('treats EXITED-normalized-to-stopped as terminal (orphan-sweep skip)', () => {
    // Critical: listInstances now returns 'stopped', never raw 'EXITED'.
    expect(normalizeInstanceStatus('EXITED')).toBe('stopped');
    expect(isTerminalInstanceStatus('EXITED')).toBe(true);
    expect(isTerminalInstanceStatus('stopped')).toBe(true);
    expect(isTerminalInstanceStatus('error')).toBe(true);
    expect(isTerminalInstanceStatus('FAILED')).toBe(true);
    expect(isBillableInstanceStatus('EXITED')).toBe(false);
    expect(isBillableInstanceStatus('stopped')).toBe(false);
  });

  it('treats running/booting as billable', () => {
    expect(isBillableInstanceStatus('running')).toBe(true);
    expect(isBillableInstanceStatus('RUNNING')).toBe(true);
    expect(isBillableInstanceStatus('booting')).toBe(true);
    expect(isBillableInstanceStatus('loading')).toBe(true);
    expect(isBillableInstanceStatus('CREATING')).toBe(true);
    expect(isTerminalInstanceStatus('running')).toBe(false);
    expect(isTerminalInstanceStatus('booting')).toBe(false);
  });

  it('unknown is neither terminal nor billable', () => {
    expect(isTerminalInstanceStatus('unknown')).toBe(false);
    expect(isBillableInstanceStatus('unknown')).toBe(false);
    expect(isTerminalInstanceStatus(null)).toBe(false);
    expect(isBillableInstanceStatus(undefined)).toBe(false);
  });
});
