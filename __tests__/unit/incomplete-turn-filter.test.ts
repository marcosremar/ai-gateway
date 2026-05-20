import { describe, it, expect } from 'vitest';
import { IncompleteTurnFilter } from '../../src/llm-context/incomplete-turn-filter';

describe('IncompleteTurnFilter', () => {
  it('augments system prompt with marker instruction', () => {
    const f = new IncompleteTurnFilter();
    const out = f.augmentSystemPrompt('You are a helpful assistant.');
    expect(out).toContain('You are a helpful assistant.');
    expect(out).toContain('✓');
    expect(out).toContain('○');
    expect(out).toContain('◐');
  });

  describe('classify (full response)', () => {
    it('treats ✓ + content as complete', () => {
      const f = new IncompleteTurnFilter();
      const d = f.classify('✓ Hello, how can I help?');
      expect(d.kind).toBe('complete');
      expect(d.cleanedText).toBe('Hello, how can I help?');
      expect(d.timeoutMs).toBe(0);
    });

    it('treats ○ as incomplete-short', () => {
      const f = new IncompleteTurnFilter({ shortTimeoutMs: 4000 });
      const d = f.classify('○');
      expect(d.kind).toBe('incomplete_short');
      expect(d.cleanedText).toBe('');
      expect(d.timeoutMs).toBe(4000);
    });

    it('treats ◐ as incomplete-long', () => {
      const f = new IncompleteTurnFilter({ longTimeoutMs: 12000 });
      const d = f.classify('◐');
      expect(d.kind).toBe('incomplete_long');
      expect(d.timeoutMs).toBe(12000);
    });

    it('fails open when no marker emitted', () => {
      const f = new IncompleteTurnFilter();
      const d = f.classify('Hello world');
      expect(d.kind).toBe('complete');
      expect(d.cleanedText).toBe('Hello world');
    });

    it('handles leading whitespace', () => {
      const f = new IncompleteTurnFilter();
      const d = f.classify('   ✓ ok');
      expect(d.kind).toBe('complete');
      expect(d.cleanedText).toBe('ok');
    });
  });

  describe('createStreamGate', () => {
    it('returns pending while waiting for first non-whitespace char', () => {
      const f = new IncompleteTurnFilter();
      const gate = f.createStreamGate();
      expect(gate.feed(' ').kind).toBe('pending');
      expect(gate.feed('  ').kind).toBe('pending');
    });

    it('emits completion text after marker arrives', () => {
      const f = new IncompleteTurnFilter();
      const gate = f.createStreamGate();
      gate.feed(' ');
      const r1 = gate.feed('✓ Hel');
      expect(r1.kind).toBe('complete');
      if (r1.kind === 'complete') expect(r1.emit).toBe('Hel');
      const r2 = gate.feed('lo');
      if (r2.kind === 'complete') expect(r2.emit).toBe('lo');
    });

    it('signals incomplete-short and suppresses further chunks', () => {
      const f = new IncompleteTurnFilter({ shortTimeoutMs: 5000 });
      const gate = f.createStreamGate();
      const r = gate.feed('○');
      expect(r.kind).toBe('incomplete_short');
      const r2 = gate.feed('garbage after');
      expect(r2.kind).toBe('suppress');
    });

    it('fails open on no marker', () => {
      const f = new IncompleteTurnFilter();
      const gate = f.createStreamGate();
      const r = gate.feed('Hi');
      expect(r.kind).toBe('complete');
      if (r.kind === 'complete') expect(r.emit).toBe('Hi');
    });

    it('finalize on empty stream returns complete with empty emit', () => {
      const f = new IncompleteTurnFilter();
      const gate = f.createStreamGate();
      const r = gate.finalize();
      expect(r.kind).toBe('complete');
      if (r.kind === 'complete') expect(r.emit).toBe('');
    });
  });
});
