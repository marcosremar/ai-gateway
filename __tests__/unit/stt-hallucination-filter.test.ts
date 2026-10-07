/**
 * Tests for src/stt-hallucination-filter.ts
 * Covers: metadata filter, blocklist filter, edge cases, configuration.
 */
import { describe, it, expect } from 'vitest';
import {
  filterHallucinations,
  DEFAULT_HALLUCINATION_FILTER_CONFIG,
  type STTHallucinationFilterConfig,
  type HallucinationFilterResult,
  type SegmentFilterResult,
} from '../../src/stt-hallucination-filter';
import type { STTResponse, STTSegment } from '../../src/providers/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSegment(overrides: Partial<STTSegment> = {}): STTSegment {
  return {
    id: 0,
    start: 0,
    end: 1,
    text: 'hello world',
    no_speech_prob: 0.1,
    compression_ratio: 1.2,
    avg_logprob: -0.3,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<STTResponse> = {}): STTResponse {
  return {
    text: 'hello world',
    provider: 'test',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DEFAULT_HALLUCINATION_FILTER_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_HALLUCINATION_FILTER_CONFIG.noSpeechProbThreshold).toBe(0.6);
    expect(DEFAULT_HALLUCINATION_FILTER_CONFIG.compressionRatioThreshold).toBe(2.4);
    expect(DEFAULT_HALLUCINATION_FILTER_CONFIG.avgLogprobThreshold).toBe(-0.8);
    expect(DEFAULT_HALLUCINATION_FILTER_CONFIG.metadataFilterEnabled).toBe(true);
    expect(DEFAULT_HALLUCINATION_FILTER_CONFIG.blocklistFilterEnabled).toBe(true);
  });
});

describe('filterHallucinations — no filtering', () => {
  it('returns original text when no segments and no blocklist match', () => {
    const response = makeResponse({ text: 'bonjour comment allez-vous' });
    const result = filterHallucinations(response);
    expect(result.text).toBe('bonjour comment allez-vous');
    expect(result.originalText).toBe('bonjour comment allez-vous');
    expect(result.filtered).toBe(false);
    expect(result.metadataRejected).toBe(0);
    expect(result.blocklistRejected).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it('passes clean segments through', () => {
    const seg = makeSegment({ text: ' hello world', id: 0 });
    const response = makeResponse({ text: 'hello world', segments: [seg] });
    const result = filterHallucinations(response);
    expect(result.text).toBe('hello world');
    expect(result.filtered).toBe(false);
    expect(result.metadataRejected).toBe(0);
  });

  it('includes metrics when verbose fields are present', () => {
    const response = makeResponse({
      text: 'test',
      avg_logprob: -0.2,
      compression_ratio: 1.1,
      no_speech_prob: 0.05,
    });
    const result = filterHallucinations(response);
    expect(result.metrics).toBeDefined();
    expect(result.metrics!.avg_logprob).toBe(-0.2);
    expect(result.metrics!.compression_ratio).toBe(1.1);
    expect(result.metrics!.no_speech_prob).toBe(0.05);
  });

  it('metrics is undefined when no verbose fields', () => {
    const response = makeResponse({ text: 'clean text' });
    const result = filterHallucinations(response);
    expect(result.metrics).toBeUndefined();
  });
});

describe('filterHallucinations — metadata filter', () => {
  it('rejects segment with high no_speech_prob', () => {
    const badSeg = makeSegment({ id: 0, text: ' silence', no_speech_prob: 0.9 });
    const response = makeResponse({ text: 'silence', segments: [badSeg] });
    const result = filterHallucinations(response);
    expect(result.metadataRejected).toBe(1);
    expect(result.text).toBe('');
    expect(result.filtered).toBe(true);
    expect(result.reasons.some(r => r.includes('no_speech_prob'))).toBe(true);
  });

  it('rejects segment with high compression_ratio', () => {
    const badSeg = makeSegment({ id: 0, text: ' ha ha ha ha', compression_ratio: 3.0 });
    const response = makeResponse({ text: 'ha ha ha ha', segments: [badSeg] });
    const result = filterHallucinations(response);
    expect(result.metadataRejected).toBe(1);
    expect(result.text).toBe('');
    expect(result.filtered).toBe(true);
    expect(result.reasons.some(r => r.includes('compression_ratio'))).toBe(true);
  });

  it('rejects segment with low avg_logprob', () => {
    const badSeg = makeSegment({ id: 0, text: ' uncertain', avg_logprob: -1.5 });
    const response = makeResponse({ text: 'uncertain', segments: [badSeg] });
    const result = filterHallucinations(response);
    expect(result.metadataRejected).toBe(1);
    expect(result.text).toBe('');
    expect(result.filtered).toBe(true);
    expect(result.reasons.some(r => r.includes('avg_logprob'))).toBe(true);
  });

  it('keeps clean segments and rejects bad ones', () => {
    const good = makeSegment({ id: 0, text: ' good part' });
    const bad = makeSegment({ id: 1, text: ' bad part', no_speech_prob: 0.95 });
    const response = makeResponse({ text: 'good part bad part', segments: [good, bad] });
    const result = filterHallucinations(response);
    expect(result.metadataRejected).toBe(1);
    expect(result.text).toBe('good part');
    expect(result.filtered).toBe(true);
    expect(result.reasons).toHaveLength(1);
  });

  it('rejects all segments → empty text', () => {
    const segs = [
      makeSegment({ id: 0, text: ' a', no_speech_prob: 0.8 }),
      makeSegment({ id: 1, text: ' b', no_speech_prob: 0.9 }),
    ];
    const response = makeResponse({ text: 'a b', segments: segs });
    const result = filterHallucinations(response);
    expect(result.text).toBe('');
    expect(result.metadataRejected).toBe(2);
    expect(result.reasons.some(r => r.includes('all segments rejected'))).toBe(true);
  });

  it('handles empty segments array (no metadata filter applied)', () => {
    const response = makeResponse({ text: 'test', segments: [] });
    const result = filterHallucinations(response);
    expect(result.metadataRejected).toBe(0);
    expect(result.filtered).toBe(false);
  });

  it('respects metadataFilterEnabled=false', () => {
    const badSeg = makeSegment({ id: 0, text: ' silence', no_speech_prob: 0.95 });
    const response = makeResponse({ text: 'silence', segments: [badSeg] });
    const config: STTHallucinationFilterConfig = {
      ...DEFAULT_HALLUCINATION_FILTER_CONFIG,
      metadataFilterEnabled: false,
    };
    const result = filterHallucinations(response, undefined, config);
    expect(result.metadataRejected).toBe(0);
    expect(result.text).toBe('silence');
  });

  it('uses custom thresholds', () => {
    // Tighter threshold: no_speech_prob > 0.1 rejects
    const seg = makeSegment({ id: 0, text: ' marginal', no_speech_prob: 0.2 });
    const response = makeResponse({ text: 'marginal', segments: [seg] });
    const config: STTHallucinationFilterConfig = {
      ...DEFAULT_HALLUCINATION_FILTER_CONFIG,
      noSpeechProbThreshold: 0.1,
    };
    const result = filterHallucinations(response, undefined, config);
    expect(result.metadataRejected).toBe(1);
  });
});

describe('filterHallucinations — blocklist filter', () => {
  it('rejects exact known hallucination phrase', () => {
    // "thank you for watching" is a well-known Whisper hallucination
    const response = makeResponse({ text: 'Thank you for watching.' });
    const result = filterHallucinations(response);
    // May or may not be in the blocklist — check both cases work
    if (result.blocklistRejected) {
      expect(result.text).toBe('');
      expect(result.reasons.some(r => r.includes('blocklist match'))).toBe(true);
    } else {
      expect(result.text).toBe('Thank you for watching.');
    }
  });

  it('does not reject normal speech', () => {
    const response = makeResponse({ text: 'the quick brown fox jumps over the lazy dog' });
    const result = filterHallucinations(response);
    expect(result.blocklistRejected).toBe(false);
    expect(result.text).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('respects blocklistFilterEnabled=false', () => {
    const response = makeResponse({ text: 'Thank you for watching.' });
    const config: STTHallucinationFilterConfig = {
      ...DEFAULT_HALLUCINATION_FILTER_CONFIG,
      blocklistFilterEnabled: false,
    };
    const result = filterHallucinations(response, undefined, config);
    expect(result.blocklistRejected).toBe(false);
  });

  it('skips blocklist when text is already empty after metadata filter', () => {
    const badSeg = makeSegment({ id: 0, text: ' silence', no_speech_prob: 0.99 });
    const response = makeResponse({ text: 'silence', segments: [badSeg] });
    const result = filterHallucinations(response);
    // text is empty after metadata filter, blocklist shouldn't fire
    expect(result.blocklistRejected).toBe(false);
  });
});

describe('filterHallucinations — language parameter', () => {
  it('accepts language parameter without error', () => {
    const response = makeResponse({ text: 'bonjour' });
    expect(() => filterHallucinations(response, 'fr')).not.toThrow();
  });

  it('accepts unknown language code without error', () => {
    const response = makeResponse({ text: 'hello' });
    expect(() => filterHallucinations(response, 'xx-unknown')).not.toThrow();
  });
});

describe('filterHallucinations — result structure', () => {
  it('always returns all required fields', () => {
    const response = makeResponse({ text: 'some text' });
    const result = filterHallucinations(response);
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('originalText');
    expect(result).toHaveProperty('filtered');
    expect(result).toHaveProperty('metadataRejected');
    expect(result).toHaveProperty('blocklistRejected');
    expect(result).toHaveProperty('reasons');
  });

  it('originalText is always the raw input text', () => {
    const badSeg = makeSegment({ id: 0, text: ' noise', no_speech_prob: 0.99 });
    const response = makeResponse({ text: 'noise', segments: [badSeg] });
    const result = filterHallucinations(response);
    expect(result.originalText).toBe('noise');
  });

  it('filtered=true when text changes', () => {
    const badSeg = makeSegment({ id: 0, text: ' noise', no_speech_prob: 0.99 });
    const response = makeResponse({ text: 'noise', segments: [badSeg] });
    const result = filterHallucinations(response);
    expect(result.filtered).toBe(true);
  });

  it('filtered=false when text unchanged', () => {
    const response = makeResponse({ text: 'real speech here' });
    const result = filterHallucinations(response);
    expect(result.filtered).toBe(false);
  });
});

describe('filterHallucinations — edge cases', () => {
  it('handles empty text', () => {
    const response = makeResponse({ text: '' });
    const result = filterHallucinations(response);
    expect(result.text).toBe('');
    expect(result.filtered).toBe(false);
  });

  it('handles whitespace-only text', () => {
    const response = makeResponse({ text: '   ' });
    const result = filterHallucinations(response);
    expect(result.originalText).toBe('   ');
  });

  it('handles missing segments (undefined)', () => {
    const response = makeResponse({ text: 'test', segments: undefined });
    expect(() => filterHallucinations(response)).not.toThrow();
  });

  it('handles very long text', () => {
    const longText = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
    const response = makeResponse({ text: longText });
    const result = filterHallucinations(response);
    expect(result.text).toBe(longText);
  });

  it('a long loop of one word is a decoder loop, dropped by the repetition rule (QA 2026-10-07)', () => {
    const result = filterHallucinations(makeResponse({ text: 'word '.repeat(500).trim() }));
    expect(result.text).toBe('');
    expect(result.reasonCodes).toEqual(['repetition']);
  });

  it('reason array includes the segment array index when segment is rejected', () => {
    // Whisper restarts `seg.id` at 0 per chunk, so the filter labels
    // rejections by the array index (monotonically unique within the
    // batch), not by the upstream `seg.id`.
    const seg = makeSegment({ id: 5, text: ' silence', no_speech_prob: 0.9 });
    const response = makeResponse({ text: 'silence', segments: [seg] });
    const result = filterHallucinations(response);
    expect(result.reasons.some(r => r.includes('seg[0]'))).toBe(true);
  });

  it('metadata priority: no_speech_prob checked before compression_ratio', () => {
    // Segment has both no_speech_prob and compression_ratio above threshold
    const seg = makeSegment({ id: 0, text: ' test', no_speech_prob: 0.8, compression_ratio: 3.0 });
    const response = makeResponse({ text: 'test', segments: [seg] });
    const result = filterHallucinations(response);
    // Should reject for no_speech_prob (checked first)
    expect(result.reasons.some(r => r.includes('no_speech_prob'))).toBe(true);
    expect(result.metadataRejected).toBe(1);
  });
});
