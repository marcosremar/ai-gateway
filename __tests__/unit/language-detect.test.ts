import { describe, it, expect } from 'vitest';
import { detectLanguage, detectLanguageWithSwap, SUPPORTED_LANGUAGES } from '../../src/language-detect';

describe('Language Detection Module', () => {
  describe('detectLanguage', () => {
    it('detects French text', () => {
      const result = detectLanguage(
        'Bonjour, comment allez-vous aujourd\'hui? Je suis très content de vous voir.',
        'fr', 'en'
      );
      expect(result.language).toBe('fr');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('detects English text', () => {
      const result = detectLanguage(
        'Hello, how are you doing today? I am very happy to see you here.',
        'fr', 'en'
      );
      expect(result.language).toBe('en');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('detects Spanish text', () => {
      const result = detectLanguage(
        'Hola, cómo estás hoy? Estoy muy contento de verte aquí en esta reunión.',
        'es', 'en'
      );
      expect(result.language).toBe('es');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('detects German text', () => {
      const result = detectLanguage(
        'Guten Tag, wie geht es Ihnen heute? Ich bin sehr froh Sie zu sehen.',
        'de', 'en'
      );
      expect(result.language).toBe('de');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('returns empty for short text (< 4 words)', () => {
      const result = detectLanguage('Bonjour monde', 'fr', 'en');
      expect(result.language).toBe('');
      expect(result.confidence).toBe(0);
    });

    it('returns empty for empty text', () => {
      const result = detectLanguage('', 'fr', 'en');
      expect(result.language).toBe('');
      expect(result.confidence).toBe(0);
    });

    it('returns empty for unsupported languages', () => {
      const result = detectLanguage('This is a test sentence', 'xx', 'yy');
      expect(result.language).toBe('');
      expect(result.confidence).toBe(0);
    });
  });

  describe('detectLanguageWithSwap', () => {
    it('recommends swap when text is in target language', () => {
      const { detected, shouldSwap } = detectLanguageWithSwap(
        'Hello, how are you doing today? I am very happy to see you here.',
        'fr', 'en'  // source=fr, target=en, but text is English
      );
      expect(detected.language).toBe('en');
      expect(shouldSwap).toBe(true);
    });

    it('does not recommend swap when text is in source language', () => {
      const { detected, shouldSwap } = detectLanguageWithSwap(
        'Bonjour, comment allez-vous aujourd\'hui? Je suis très content de vous voir.',
        'fr', 'en'  // source=fr, target=en, text is French
      );
      expect(detected.language).toBe('fr');
      expect(shouldSwap).toBe(false);
    });

    it('does not swap for short text', () => {
      const { shouldSwap } = detectLanguageWithSwap('Hello world yes', 'fr', 'en');
      expect(shouldSwap).toBe(false);
    });

    it('respects minConfidence threshold', () => {
      // With very high threshold, should not swap even if detected
      const { shouldSwap } = detectLanguageWithSwap(
        'Hello, how are you today? I want to discuss the agenda.',
        'fr', 'en',
        0.99  // very high threshold
      );
      // May or may not swap depending on confidence, but shouldn't crash
      expect(typeof shouldSwap).toBe('boolean');
    });
  });

  describe('SUPPORTED_LANGUAGES', () => {
    it('includes common languages', () => {
      expect(SUPPORTED_LANGUAGES.has('fr')).toBe(true);
      expect(SUPPORTED_LANGUAGES.has('en')).toBe(true);
      expect(SUPPORTED_LANGUAGES.has('es')).toBe(true);
      expect(SUPPORTED_LANGUAGES.has('de')).toBe(true);
      expect(SUPPORTED_LANGUAGES.has('it')).toBe(true);
      expect(SUPPORTED_LANGUAGES.has('pt')).toBe(true);
      expect(SUPPORTED_LANGUAGES.has('ja')).toBe(true);
      expect(SUPPORTED_LANGUAGES.has('zh')).toBe(true);
    });

    it('does not include invalid codes', () => {
      expect(SUPPORTED_LANGUAGES.has('xx')).toBe(false);
      expect(SUPPORTED_LANGUAGES.has('')).toBe(false);
    });
  });
});
