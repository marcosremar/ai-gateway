/**
 * AI Handlers Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  DEFAULT_TIMEOUTS,
  GPU_TIMEOUTS,
  adaptiveTimeout,
  getStageTimeout,
  validateLanguage,
  getLanguageName,
  HALLUCINATION_FILTER_CONFIG,
} from '../../server/handlers/ai/config';

import {
  generateRequestId,
  filterHallucinations,
  parseQueryParams,
  wantsStream,
} from '../../server/handlers/ai/utils';

describe('AI Config Module', () => {
  describe('DEFAULT_TIMEOUTS', () => {
    it('should have STT timeout of 30s', () => {
      expect(DEFAULT_TIMEOUTS.STT).toBe(30000);
    });

    it('should have LLM timeout of 60s', () => {
      expect(DEFAULT_TIMEOUTS.LLM).toBe(60000);
    });

    it('should have TTS timeout of 45s', () => {
      expect(DEFAULT_TIMEOUTS.TTS).toBe(45000);
    });
  });

  describe('GPU_TIMEOUTS', () => {
    it('should have faster STT timeout than cloud', () => {
      expect(GPU_TIMEOUTS.STT).toBeLessThan(DEFAULT_TIMEOUTS.STT);
    });
  });

  describe('adaptiveTimeout', () => {
    it('should return base timeout by default', () => {
      const timeout = adaptiveTimeout(10000);
      expect(timeout).toBeGreaterThanOrEqual(8000);
      expect(timeout).toBeLessThanOrEqual(12000);
    });

    it('should reduce timeout for GPU', () => {
      const cloud = adaptiveTimeout(10000, { isGpu: false });
      const gpu = adaptiveTimeout(10000, { isGpu: true });
      expect(gpu).toBeLessThan(cloud);
    });

    it('should increase timeout on retries', () => {
      const first = adaptiveTimeout(10000, { retryCount: 0 });
      const second = adaptiveTimeout(10000, { retryCount: 1 });
      expect(second).toBeGreaterThan(first);
    });

    it('should cap at 5 minutes', () => {
      const timeout = adaptiveTimeout(200000, { retryCount: 10 });
      expect(timeout).toBe(300000);
    });
  });

  describe('getStageTimeout', () => {
    it('should return STT timeout', () => {
      const timeout = getStageTimeout('stt', 'cloud');
      expect(timeout).toBeGreaterThan(0);
    });

    it('should return different timeouts for GPU vs cloud', () => {
      const cloud = getStageTimeout('stt', 'cloud');
      const gpu = getStageTimeout('stt', 'gpu');
      expect(gpu).toBeLessThan(cloud);
    });
  });

  describe('validateLanguage', () => {
    it('should validate English', () => {
      expect(validateLanguage('en')).toBe(true);
    });

    it('should validate Spanish', () => {
      expect(validateLanguage('es')).toBe(true);
    });

    it('should validate auto', () => {
      expect(validateLanguage('auto')).toBe(true);
    });

    it('should reject invalid language', () => {
      expect(validateLanguage('invalid')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(validateLanguage('EN')).toBe(true);
      expect(validateLanguage('En')).toBe(true);
    });
  });

  describe('getLanguageName', () => {
    it('should return English for en', () => {
      expect(getLanguageName('en')).toBe('English');
    });

    it('should return Spanish for es', () => {
      expect(getLanguageName('es')).toBe('Spanish');
    });

    it('should return input for unknown language', () => {
      expect(getLanguageName('unknown')).toBe('unknown');
    });
  });
});

describe('AI Utils Module', () => {
  describe('generateRequestId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      expect(id1).not.toBe(id2);
      expect(id1).toContain('req-');
    });

    it('should include timestamp', () => {
      const id = generateRequestId();
      const parts = id.split('-');
      expect(parts.length).toBeGreaterThanOrEqual(2);
      const timestamp = parseInt(parts[1]);
      expect(timestamp).toBeGreaterThan(0);
    });
  });

  describe('filterHallucinations', () => {
    it('should filter blocked phrases', () => {
      const result = filterHallucinations('Thank you for watching this video');
      expect(result.filtered).toBe(true);
      expect(result.text).not.toContain('thank you for watching');
    });

    it('should not filter normal text', () => {
      const text = 'This is a normal transcription';
      const result = filterHallucinations(text);
      expect(result.filtered).toBe(false);
      expect(result.text).toBe(text);
    });

    it('should handle empty text', () => {
      const result = filterHallucinations('');
      expect(result.filtered).toBe(false);
      expect(result.text).toBe('');
    });

    it('should clean up extra spaces', () => {
      const result = filterHallucinations('Thank   you   for watching');
      expect(result.text).not.toContain('  ');
    });

    it('should use custom blocked phrases', () => {
      const result = filterHallucinations('custom blocked phrase here', {
        blockedPhrases: ['custom blocked phrase'],
      });
      expect(result.filtered).toBe(true);
      expect(result.text).not.toContain('custom blocked phrase');
    });
  });

  describe('parseQueryParams', () => {
    it('should parse query string', () => {
      const params = parseQueryParams('https://example.com?key1=value1&key2=value2');
      expect(params).toEqual({
        key1: 'value1',
        key2: 'value2',
      });
    });

    it('should decode URL-encoded values', () => {
      const params = parseQueryParams('https://example.com?name=John%20Doe');
      expect(params.name).toBe('John Doe');
    });

    it('should handle empty query string', () => {
      const params = parseQueryParams('https://example.com');
      expect(params).toEqual({});
    });

    it('should handle empty values', () => {
      const params = parseQueryParams('https://example.com?key=');
      expect(params.key).toBe('');
    });
  });

  describe('wantsStream', () => {
    it('should return true for SSE accept header', () => {
      const req = {
        headers: { accept: 'text/event-stream' },
      } as any;
      expect(wantsStream(req)).toBe(true);
    });

    it('should return false for JSON accept header', () => {
      const req = {
        headers: { accept: 'application/json' },
      } as any;
      expect(wantsStream(req)).toBe(false);
    });

    it('should return false when no accept header', () => {
      const req = { headers: {} } as any;
      expect(wantsStream(req)).toBe(false);
    });
  });
});

describe('Hallucination Filter Config', () => {
  it('should have blocked phrases', () => {
    expect(HALLUCINATION_FILTER_CONFIG.blockedPhrases.length).toBeGreaterThan(0);
    expect(HALLUCINATION_FILTER_CONFIG.blockedPhrases).toContain('thank you for watching');
  });

  it('should be enabled by default', () => {
    expect(HALLUCINATION_FILTER_CONFIG.enabled).toBe(true);
  });
});
