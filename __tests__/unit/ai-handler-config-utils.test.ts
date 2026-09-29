// Unit tests for server/handlers/ai/config.ts and server/handlers/ai/utils.ts
// Pure business logic: adaptive timeouts, language validation, hallucination
// filtering, query-param parsing, and request-type sniffing.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMEOUTS,
  GPU_TIMEOUTS,
  adaptiveTimeout,
  getStageTimeout,
  validateLanguage,
  getLanguageName,
  ENSEMBLE_STT_PROVIDERS,
  PROVIDER_PRIORITY,
  HALLUCINATION_FILTER_CONFIG,
} from '../../server/handlers/ai/config';
import {
  filterHallucinations,
  parseQueryParams,
  wantsStream,
  wantsBinaryAudio,
  generateRequestId,
} from '../../server/handlers/ai/utils';

// ── adaptiveTimeout ───────────────────────────────────────────────────────────

describe('adaptiveTimeout', () => {
  it('returns base ms unchanged with default options', () => {
    // loadFactor=1.0, retryCount=0, isGpu=false → all multipliers are 1
    expect(adaptiveTimeout(10_000)).toBe(10_000);
  });

  it('applies GPU multiplier (0.7) when isGpu=true', () => {
    expect(adaptiveTimeout(10_000, { isGpu: true })).toBe(7_000);
  });

  it('increases timeout by 50% per retry (retryMultiplier = 1 + retryCount * 0.5)', () => {
    // retryCount=1 → 1.5x
    expect(adaptiveTimeout(10_000, { retryCount: 1 })).toBe(15_000);
    // retryCount=2 → 2x
    expect(adaptiveTimeout(10_000, { retryCount: 2 })).toBe(20_000);
    // retryCount=3 → 2.5x
    expect(adaptiveTimeout(10_000, { retryCount: 3 })).toBe(25_000);
  });

  it('scales by loadFactor clamped to [0.8, 2.0]', () => {
    // loadFactor=2.0 → 2x
    expect(adaptiveTimeout(10_000, { loadFactor: 2.0 })).toBe(20_000);
    // loadFactor=1.5 → 1.5x
    expect(adaptiveTimeout(10_000, { loadFactor: 1.5 })).toBe(15_000);
  });

  it('clamps loadFactor floor to 0.8 when below minimum', () => {
    // loadFactor=0.0 → clamped to 0.8 → 8000
    expect(adaptiveTimeout(10_000, { loadFactor: 0 })).toBe(8_000);
    expect(adaptiveTimeout(10_000, { loadFactor: 0.5 })).toBe(8_000);
  });

  it('clamps loadFactor ceiling to 2.0 when above maximum', () => {
    expect(adaptiveTimeout(10_000, { loadFactor: 5.0 })).toBe(20_000);
    expect(adaptiveTimeout(10_000, { loadFactor: 10.0 })).toBe(20_000);
  });

  it('caps final timeout at 300 000 ms (5 minutes)', () => {
    // Large base + high load should still cap
    expect(adaptiveTimeout(200_000, { loadFactor: 2.0, retryCount: 5 })).toBe(300_000);
    expect(adaptiveTimeout(1_000_000)).toBe(300_000);
  });

  it('combines GPU + retry multipliers correctly', () => {
    // baseMs=10000, isGpu=true (0.7), retryCount=2 (2.0) → 14000
    expect(adaptiveTimeout(10_000, { isGpu: true, retryCount: 2 })).toBe(14_000);
  });

  it('combines GPU + loadFactor correctly', () => {
    // baseMs=10000, isGpu=true (0.7), loadFactor=2.0 → 14000
    expect(adaptiveTimeout(10_000, { isGpu: true, loadFactor: 2.0 })).toBe(14_000);
  });

  it('rounds the result to the nearest integer', () => {
    // 10001 * 0.7 = 7000.7 → rounds to 7001
    expect(adaptiveTimeout(10_001, { isGpu: true })).toBe(7_001);
  });

  it('handles zero base ms without crashing', () => {
    expect(adaptiveTimeout(0)).toBe(0);
  });
});

// ── getStageTimeout ───────────────────────────────────────────────────────────

describe('getStageTimeout', () => {
  it('returns cloud DEFAULT_TIMEOUTS for stt on cloud', () => {
    // cloud stt → DEFAULT_TIMEOUTS.STT (30000), no GPU multiplier
    expect(getStageTimeout('stt', 'cloud')).toBe(DEFAULT_TIMEOUTS.STT);
  });

  it('returns cloud DEFAULT_TIMEOUTS for llm on cloud', () => {
    expect(getStageTimeout('llm', 'cloud')).toBe(DEFAULT_TIMEOUTS.LLM);
  });

  it('returns cloud DEFAULT_TIMEOUTS for tts on cloud', () => {
    expect(getStageTimeout('tts', 'cloud')).toBe(DEFAULT_TIMEOUTS.TTS);
  });

  it('returns cloud DEFAULT_TIMEOUTS for pipeline on cloud', () => {
    expect(getStageTimeout('pipeline', 'cloud')).toBe(DEFAULT_TIMEOUTS.PIPELINE);
  });

  it('applies GPU multiplier (0.7) for stt on gpu', () => {
    // GPU_TIMEOUTS.STT = 15000, with isGpu=true (0.7) → 10500
    expect(getStageTimeout('stt', 'gpu')).toBe(Math.round(GPU_TIMEOUTS.STT * 0.7));
  });

  it('applies GPU multiplier (0.7) for llm on gpu', () => {
    expect(getStageTimeout('llm', 'gpu')).toBe(Math.round(GPU_TIMEOUTS.LLM * 0.7));
  });

  it('applies GPU multiplier (0.7) for tts on gpu', () => {
    expect(getStageTimeout('tts', 'gpu')).toBe(Math.round(GPU_TIMEOUTS.TTS * 0.7));
  });

  it('defaults to cloud when provider is omitted', () => {
    expect(getStageTimeout('stt')).toBe(getStageTimeout('stt', 'cloud'));
  });

  it('passes retryCount through to adaptiveTimeout', () => {
    const base = getStageTimeout('llm', 'cloud');
    const retry1 = getStageTimeout('llm', 'cloud', { retryCount: 1 });
    // retryMultiplier = 1.5
    expect(retry1).toBe(Math.round(DEFAULT_TIMEOUTS.LLM * 1.5));
    expect(retry1).toBeGreaterThan(base);
  });

  it('passes loadFactor through to adaptiveTimeout', () => {
    const base = getStageTimeout('tts', 'cloud');
    const loaded = getStageTimeout('tts', 'cloud', { loadFactor: 1.5 });
    expect(loaded).toBe(Math.round(DEFAULT_TIMEOUTS.TTS * 1.5));
    expect(loaded).toBeGreaterThan(base);
  });
});

// ── DEFAULT_TIMEOUTS / GPU_TIMEOUTS values ────────────────────────────────────

describe('timeout constants', () => {
  it('DEFAULT_TIMEOUTS has expected millisecond values', () => {
    expect(DEFAULT_TIMEOUTS.STT).toBe(30_000);
    expect(DEFAULT_TIMEOUTS.LLM).toBe(60_000);
    expect(DEFAULT_TIMEOUTS.TTS).toBe(45_000);
    expect(DEFAULT_TIMEOUTS.PIPELINE).toBe(120_000);
    expect(DEFAULT_TIMEOUTS.CHAT).toBe(90_000);
  });

  it('GPU_TIMEOUTS are faster than DEFAULT_TIMEOUTS for every shared key', () => {
    expect(GPU_TIMEOUTS.STT).toBeLessThan(DEFAULT_TIMEOUTS.STT);
    expect(GPU_TIMEOUTS.LLM).toBeLessThan(DEFAULT_TIMEOUTS.LLM);
    expect(GPU_TIMEOUTS.TTS).toBeLessThan(DEFAULT_TIMEOUTS.TTS);
    expect(GPU_TIMEOUTS.PIPELINE).toBeLessThan(DEFAULT_TIMEOUTS.PIPELINE);
  });
});

// ── validateLanguage ──────────────────────────────────────────────────────────

describe('validateLanguage', () => {
  it('accepts all common two-letter language codes', () => {
    const common = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'zh', 'ko'];
    for (const lang of common) {
      expect(validateLanguage(lang), `expected ${lang} to be valid`).toBe(true);
    }
  });

  it('accepts "auto" for auto-detect', () => {
    expect(validateLanguage('auto')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(validateLanguage('EN')).toBe(true);
    expect(validateLanguage('Fr')).toBe(true);
    expect(validateLanguage('AUTO')).toBe(true);
  });

  it('rejects unknown codes', () => {
    expect(validateLanguage('xx')).toBe(false);
    expect(validateLanguage('zz')).toBe(false);
    expect(validateLanguage('123')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateLanguage('')).toBe(false);
  });

  it('rejects full language names', () => {
    expect(validateLanguage('English')).toBe(false);
    expect(validateLanguage('French')).toBe(false);
  });

  it('accepts less-common but valid codes (ar, hi, tr, vi, th, id)', () => {
    for (const lang of ['ar', 'hi', 'tr', 'vi', 'th', 'id']) {
      expect(validateLanguage(lang), `expected ${lang} to be valid`).toBe(true);
    }
  });

  it('accepts Nordic and Eastern European codes', () => {
    for (const lang of ['sv', 'da', 'fi', 'no', 'hu', 'ro', 'sk', 'uk', 'bg']) {
      expect(validateLanguage(lang)).toBe(true);
    }
  });
});

// ── getLanguageName ───────────────────────────────────────────────────────────

describe('getLanguageName', () => {
  it('returns full English name for common codes', () => {
    expect(getLanguageName('en')).toBe('English');
    expect(getLanguageName('fr')).toBe('French');
    expect(getLanguageName('de')).toBe('German');
    expect(getLanguageName('es')).toBe('Spanish');
    expect(getLanguageName('ja')).toBe('Japanese');
    expect(getLanguageName('zh')).toBe('Chinese');
    expect(getLanguageName('ko')).toBe('Korean');
    expect(getLanguageName('ar')).toBe('Arabic');
    expect(getLanguageName('hi')).toBe('Hindi');
  });

  it('returns "Auto-detect" for "auto"', () => {
    expect(getLanguageName('auto')).toBe('Auto-detect');
  });

  it('is case-insensitive', () => {
    expect(getLanguageName('EN')).toBe('English');
    expect(getLanguageName('FR')).toBe('French');
  });

  it('returns the raw code when no mapping exists', () => {
    expect(getLanguageName('xx')).toBe('xx');
    expect(getLanguageName('zz')).toBe('zz');
    expect(getLanguageName('xyz')).toBe('xyz');
  });

  it('returns empty string for empty input', () => {
    expect(getLanguageName('')).toBe('');
  });
});

// ── ENSEMBLE_STT_PROVIDERS / PROVIDER_PRIORITY ────────────────────────────────

describe('configuration constants', () => {
  it('ENSEMBLE_STT_PROVIDERS lists the four standard providers', () => {
    expect(ENSEMBLE_STT_PROVIDERS).toContain('groq');
    expect(ENSEMBLE_STT_PROVIDERS).toContain('deepgram');
    expect(ENSEMBLE_STT_PROVIDERS).toContain('fireworks');
    expect(ENSEMBLE_STT_PROVIDERS).toContain('openai');
    expect(ENSEMBLE_STT_PROVIDERS).toHaveLength(4);
  });

  it('PROVIDER_PRIORITY has entries for stt, llm, and tts', () => {
    expect(PROVIDER_PRIORITY.stt).toBeDefined();
    expect(PROVIDER_PRIORITY.llm).toBeDefined();
    expect(PROVIDER_PRIORITY.tts).toBeDefined();
  });

  it('PROVIDER_PRIORITY.stt puts gpu first', () => {
    expect(PROVIDER_PRIORITY.stt[0]).toBe('gpu');
  });

  it('HALLUCINATION_FILTER_CONFIG is enabled by default', () => {
    expect(HALLUCINATION_FILTER_CONFIG.enabled).toBe(true);
  });

  it('HALLUCINATION_FILTER_CONFIG has default blocked phrases', () => {
    expect(HALLUCINATION_FILTER_CONFIG.blockedPhrases).toContain('thank you for watching');
    expect(HALLUCINATION_FILTER_CONFIG.blockedPhrases).toContain('like and subscribe');
  });
});

// ── filterHallucinations ──────────────────────────────────────────────────────

describe('filterHallucinations', () => {
  it('returns unchanged text and filtered=false when no blocked phrase present', () => {
    const result = filterHallucinations('Hello world, this is a test.');
    expect(result.text).toBe('Hello world, this is a test.');
    expect(result.filtered).toBe(false);
  });

  it('removes a default blocked phrase and sets filtered=true', () => {
    const result = filterHallucinations('Thank you for watching this video.');
    expect(result.filtered).toBe(true);
    expect(result.text.toLowerCase()).not.toContain('thank you for watching');
  });

  it('is case-insensitive when matching blocked phrases', () => {
    const result = filterHallucinations('THANK YOU FOR WATCHING.');
    expect(result.filtered).toBe(true);
    expect(result.text.trim().toLowerCase()).not.toContain('thank you for watching');
  });

  it('removes "subscribe to my channel" phrase', () => {
    const result = filterHallucinations('Please subscribe to my channel for more.');
    expect(result.filtered).toBe(true);
    expect(result.text.toLowerCase()).not.toContain('subscribe to my channel');
  });

  it('removes "like and subscribe" phrase', () => {
    const result = filterHallucinations('Like and subscribe for updates.');
    expect(result.filtered).toBe(true);
    expect(result.text.toLowerCase()).not.toContain('like and subscribe');
  });

  it('collapses multiple spaces after removal', () => {
    const result = filterHallucinations('Hello. Thank you for watching. Goodbye.');
    // After removal, extra spaces are collapsed
    expect(result.text).not.toMatch(/\s{2,}/);
  });

  it('trims leading and trailing whitespace after removal', () => {
    const result = filterHallucinations('Thank you for watching');
    // Phrase is the entire string — result should be empty after trim
    expect(result.text).toBe('');
  });

  it('uses custom blockedPhrases when provided', () => {
    const result = filterHallucinations('This is spam content.', {
      blockedPhrases: ['spam content'],
    });
    expect(result.filtered).toBe(true);
    expect(result.text.toLowerCase()).not.toContain('spam content');
  });

  it('does NOT use default blocked phrases when custom list is provided', () => {
    const result = filterHallucinations('Thank you for watching', {
      blockedPhrases: ['unrelated phrase'],
    });
    // Custom blocklist doesn't contain the default phrase — nothing matched
    expect(result.filtered).toBe(false);
    expect(result.text.toLowerCase()).toContain('thank you for watching');
  });

  it('handles multiple blocked phrases in one string', () => {
    const result = filterHallucinations('Like and subscribe and also thank you for watching!');
    expect(result.filtered).toBe(true);
    const lower = result.text.toLowerCase();
    expect(lower).not.toContain('like and subscribe');
    expect(lower).not.toContain('thank you for watching');
  });

  it('preserves content that does not match any blocked phrase', () => {
    const result = filterHallucinations('The meeting starts at 3pm today.');
    expect(result.text).toBe('The meeting starts at 3pm today.');
    expect(result.filtered).toBe(false);
  });

  it('handles empty string input', () => {
    const result = filterHallucinations('');
    expect(result.text).toBe('');
    expect(result.filtered).toBe(false);
  });

  it('handles empty blocked phrases list', () => {
    const result = filterHallucinations('Thank you for watching', { blockedPhrases: [] });
    expect(result.filtered).toBe(false);
    expect(result.text).toBe('Thank you for watching');
  });
});

// ── parseQueryParams ──────────────────────────────────────────────────────────

describe('parseQueryParams', () => {
  it('returns empty object for a URL without query string', () => {
    expect(parseQueryParams('/v1/health')).toEqual({});
  });

  it('parses a single key-value pair', () => {
    expect(parseQueryParams('/v1/speech?lang=en')).toEqual({ lang: 'en' });
  });

  it('parses multiple key-value pairs', () => {
    expect(parseQueryParams('/v1/speech?lang=fr&style=formal')).toEqual({
      lang: 'fr',
      style: 'formal',
    });
  });

  it('URL-decodes keys and values', () => {
    expect(parseQueryParams('/v1/speech?msg=hello%20world')).toEqual({ msg: 'hello world' });
  });

  it('treats a key without a value as empty string', () => {
    expect(parseQueryParams('/v1/speech?flag')).toEqual({ flag: '' });
  });

  it('handles query string starting with ?', () => {
    const result = parseQueryParams('?a=1&b=2');
    expect(result).toEqual({ a: '1', b: '2' });
  });

  it('handles a URL with no path, just query string', () => {
    expect(parseQueryParams('?x=hello')).toEqual({ x: 'hello' });
  });

  it('returns empty object for URL ending in ?', () => {
    // Split on '?' gives ['url', ''], then split('&') gives [''], key is empty → skipped
    expect(parseQueryParams('/path?')).toEqual({});
  });

  it('handles numeric string values correctly', () => {
    expect(parseQueryParams('/path?count=5&limit=100')).toEqual({ count: '5', limit: '100' });
  });

  it('last duplicate key wins (native split behaviour)', () => {
    const result = parseQueryParams('/path?key=first&key=second');
    // Both would set result.key; last assignment wins
    expect(result.key).toBe('second');
  });
});

// ── wantsStream ──────────────────────────────────────────────────────────────

describe('wantsStream', () => {
  function makeReq(accept?: string): { headers: Record<string, string | undefined> } {
    return { headers: { accept } };
  }

  it('returns true when Accept contains text/event-stream', () => {
    expect(wantsStream(makeReq('text/event-stream') as any)).toBe(true);
  });

  it('returns true when Accept is a multi-value header containing text/event-stream', () => {
    expect(wantsStream(makeReq('application/json, text/event-stream') as any)).toBe(true);
  });

  it('returns false when Accept does not contain text/event-stream', () => {
    expect(wantsStream(makeReq('application/json') as any)).toBe(false);
  });

  it('returns false when Accept header is absent', () => {
    expect(wantsStream(makeReq(undefined) as any)).toBe(false);
  });

  it('returns false for empty Accept header', () => {
    expect(wantsStream(makeReq('') as any)).toBe(false);
  });
});

// ── wantsBinaryAudio ──────────────────────────────────────────────────────────

describe('wantsBinaryAudio', () => {
  function makeReq(accept?: string): { headers: Record<string, string | undefined> } {
    return { headers: { accept } };
  }

  it('returns true when Accept contains audio/wav', () => {
    expect(wantsBinaryAudio(makeReq('audio/wav') as any)).toBe(true);
  });

  it('returns true when Accept contains audio/mpeg (mp3)', () => {
    expect(wantsBinaryAudio(makeReq('audio/mpeg') as any)).toBe(true);
  });

  it('returns true when Accept is a multi-value header including audio/', () => {
    expect(wantsBinaryAudio(makeReq('application/json, audio/wav') as any)).toBe(true);
  });

  it('returns false when Accept is application/json', () => {
    expect(wantsBinaryAudio(makeReq('application/json') as any)).toBe(false);
  });

  it('returns false when Accept header is absent', () => {
    expect(wantsBinaryAudio(makeReq(undefined) as any)).toBe(false);
  });

  it('returns false for empty Accept header', () => {
    expect(wantsBinaryAudio(makeReq('') as any)).toBe(false);
  });

  it('returns false for text/event-stream (streaming, not binary audio)', () => {
    expect(wantsBinaryAudio(makeReq('text/event-stream') as any)).toBe(false);
  });
});

// ── generateRequestId ─────────────────────────────────────────────────────────

describe('generateRequestId', () => {
  it('starts with "req-"', () => {
    expect(generateRequestId()).toMatch(/^req-/);
  });

  it('contains a timestamp component', () => {
    // Format: req-<timestamp>-<random>
    const id = generateRequestId();
    const parts = id.split('-');
    expect(parts.length).toBeGreaterThanOrEqual(3);
    // Second part is a numeric timestamp
    expect(Number(parts[1])).toBeGreaterThan(0);
  });

  it('generates unique IDs on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateRequestId()));
    expect(ids.size).toBe(20);
  });
});
