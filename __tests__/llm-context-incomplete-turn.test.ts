/**
 * IncompleteTurnFilter — classify + streaming gate unit tests
 *
 * Covers:
 *   - augmentSystemPrompt: instruction injection
 *   - classify: marker detection, fail-open, custom markers, timeouts
 *   - createStreamGate: pending/complete/suppress states, streaming edge cases
 */

import { describe, it, expect } from 'vitest';
import { IncompleteTurnFilter } from '../src/llm-context/incomplete-turn-filter';

// ── augmentSystemPrompt ──────────────────────────────────────────────────────

describe('augmentSystemPrompt', () => {
  it('appends marker instruction to system prompt', () => {
    const filter = new IncompleteTurnFilter();
    const result = filter.augmentSystemPrompt('You are a helpful assistant.');
    expect(result).toContain('You are a helpful assistant.');
    expect(result).toContain('Turn-completeness marker');
    expect(result).toContain('✓');
    expect(result).toContain('○');
    expect(result).toContain('◐');
  });

  it('preserves original prompt verbatim', () => {
    const filter = new IncompleteTurnFilter();
    const original = 'System: do X and Y.';
    const result = filter.augmentSystemPrompt(original);
    expect(result.startsWith(original)).toBe(true);
  });

  it('works with empty system prompt', () => {
    const filter = new IncompleteTurnFilter();
    const result = filter.augmentSystemPrompt('');
    expect(result).toContain('Turn-completeness marker');
  });
});

// ── classify ────────────────────────────────────────────────────────────────

describe('classify', () => {
  const filter = new IncompleteTurnFilter();

  it('✓ marker → complete, strips marker, timeoutMs=0', () => {
    const result = filter.classify('✓Hello!');
    expect(result.kind).toBe('complete');
    expect(result.cleanedText).toBe('Hello!');
    expect(result.timeoutMs).toBe(0);
  });

  it('✓ marker with leading whitespace stripped from cleaned text', () => {
    const result = filter.classify('✓ Hello world');
    expect(result.kind).toBe('complete');
    expect(result.cleanedText).toBe('Hello world');
  });

  it('○ marker → incomplete_short, default 5000ms', () => {
    const result = filter.classify('○');
    expect(result.kind).toBe('incomplete_short');
    expect(result.cleanedText).toBe('');
    expect(result.timeoutMs).toBe(5000);
  });

  it('◐ marker → incomplete_long, default 10000ms', () => {
    const result = filter.classify('◐');
    expect(result.kind).toBe('incomplete_long');
    expect(result.cleanedText).toBe('');
    expect(result.timeoutMs).toBe(10000);
  });

  it('no marker → fail-open as complete, full text preserved', () => {
    const result = filter.classify('Hello, how can I help?');
    expect(result.kind).toBe('complete');
    expect(result.cleanedText).toBe('Hello, how can I help?');
    expect(result.timeoutMs).toBe(0);
  });

  it('empty response → fail-open as complete', () => {
    const result = filter.classify('');
    expect(result.kind).toBe('complete');
    expect(result.cleanedText).toBe('');
  });

  it('trims leading whitespace before checking marker', () => {
    const result = filter.classify('   ✓Reply text');
    expect(result.kind).toBe('complete');
    expect(result.cleanedText).toBe('Reply text');
  });

  it('trims leading whitespace before ○ marker', () => {
    const result = filter.classify('  ○');
    expect(result.kind).toBe('incomplete_short');
    expect(result.cleanedText).toBe('');
  });

  it('custom timeouts are respected', () => {
    const custom = new IncompleteTurnFilter({ shortTimeoutMs: 1000, longTimeoutMs: 3000 });
    expect(custom.classify('○').timeoutMs).toBe(1000);
    expect(custom.classify('◐').timeoutMs).toBe(3000);
  });

  it('custom markers are respected', () => {
    const custom = new IncompleteTurnFilter({
      markers: { complete: 'C', short: 'S', long: 'L' },
    });
    expect(custom.classify('C response text').kind).toBe('complete');
    expect(custom.classify('C response text').cleanedText).toBe('response text');
    expect(custom.classify('S').kind).toBe('incomplete_short');
    expect(custom.classify('L').kind).toBe('incomplete_long');
    // Original markers should now be treated as no-marker
    expect(custom.classify('✓Hello').kind).toBe('complete');
    expect(custom.classify('✓Hello').cleanedText).toBe('✓Hello');
  });
});

// ── createStreamGate ─────────────────────────────────────────────────────────

describe('createStreamGate', () => {
  it('returns pending while no tokens arrive', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    // No feed yet → pending
    expect(gate.finalize()).toEqual({ kind: 'complete', emit: '' });
  });

  it('pending on whitespace-only chunks before marker', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    expect(gate.feed('  ')).toEqual({ kind: 'pending' });
    expect(gate.feed('\n')).toEqual({ kind: 'pending' });
  });

  it('✓ marker chunk → complete with rest of text', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    const d = gate.feed('✓Hello');
    expect(d.kind).toBe('complete');
    expect((d as { kind: 'complete'; emit: string }).emit).toBe('Hello');
  });

  it('✓ marker with trailing space stripped from first chunk', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    const d = gate.feed('✓ Reply here');
    expect(d.kind).toBe('complete');
    expect((d as { kind: 'complete'; emit: string }).emit).toBe('Reply here');
  });

  it('subsequent chunks forwarded after complete resolved', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    gate.feed('✓First');
    const d2 = gate.feed(' second');
    expect(d2.kind).toBe('complete');
    expect((d2 as { kind: 'complete'; emit: string }).emit).toBe(' second');
  });

  it('○ marker → incomplete_short, subsequent chunks suppressed', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    const d1 = gate.feed('○');
    expect(d1.kind).toBe('incomplete_short');
    expect((d1 as { kind: 'incomplete_short'; timeoutMs: number }).timeoutMs).toBe(5000);
    const d2 = gate.feed('more text');
    expect(d2.kind).toBe('suppress');
  });

  it('◐ marker → incomplete_long, subsequent chunks suppressed', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    const d1 = gate.feed('◐');
    expect(d1.kind).toBe('incomplete_long');
    expect((d1 as { kind: 'incomplete_long'; timeoutMs: number }).timeoutMs).toBe(10000);
    const d2 = gate.feed('extra');
    expect(d2.kind).toBe('suppress');
  });

  it('no marker in first non-whitespace chunk → fail-open complete', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    const d = gate.feed('Hello');
    expect(d.kind).toBe('complete');
    // entire buffer forwarded
    expect((d as { kind: 'complete'; emit: string }).emit).toBe('Hello');
  });

  it('fail-open forwards earlier accumulated whitespace buffer', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    gate.feed('  '); // whitespace, still pending
    const d = gate.feed('No marker here');
    expect(d.kind).toBe('complete');
    // full buffer = '  No marker here'
    expect((d as { kind: 'complete'; emit: string }).emit).toBe('  No marker here');
  });

  it('finalize before any tokens → complete with empty emit', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    const d = gate.finalize();
    expect(d.kind).toBe('complete');
    expect((d as { kind: 'complete'; emit: string }).emit).toBe('');
  });

  it('finalize after complete → complete with empty emit', () => {
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    gate.feed('✓first chunk');
    const d = gate.finalize();
    expect(d.kind).toBe('complete');
    expect((d as { kind: 'complete'; emit: string }).emit).toBe('');
  });

  it('marker split across two chunks resolves correctly', () => {
    // ✓ is a multi-byte UTF-8 char; JS strings are UTF-16 so one char.
    // Simulate it arriving in two feeds with the marker alone first.
    const filter = new IncompleteTurnFilter();
    const gate = filter.createStreamGate();
    // First chunk is ONLY the ✓ marker
    const d1 = gate.feed('✓');
    expect(d1.kind).toBe('complete');
    expect((d1 as { kind: 'complete'; emit: string }).emit).toBe('');
    // Second chunk has the actual text
    const d2 = gate.feed('continuation');
    expect(d2.kind).toBe('complete');
    expect((d2 as { kind: 'complete'; emit: string }).emit).toBe('continuation');
  });

  it('custom markers work in stream gate', () => {
    const filter = new IncompleteTurnFilter({
      markers: { complete: 'C', short: 'S', long: 'L' },
    });
    const gate = filter.createStreamGate();
    const d = gate.feed('C response');
    expect(d.kind).toBe('complete');
    expect((d as { kind: 'complete'; emit: string }).emit).toBe('response');
  });

  it('each gate instance is independent', () => {
    const filter = new IncompleteTurnFilter();
    const g1 = filter.createStreamGate();
    const g2 = filter.createStreamGate();
    g1.feed('○'); // g1 → incomplete_short
    // g2 should still be pending
    const d = g2.feed('✓All good');
    expect(d.kind).toBe('complete');
  });
});
