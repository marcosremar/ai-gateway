/**
 * Pure logic of the live room page (src/rooms/page.ts → ROOM_PAGE_LOGIC): default language choice and the one-line fit
 * of the live line. The same source string that ships inside the page is evaluated here.
 */
import { describe, expect, it } from 'vitest';
import { ROOM_PAGE_LOGIC, roomPage } from '../../../src/rooms/page';

interface Fit { px: number; text: string }
type Measure = (s: string, px: number) => number;
const logic = new Function(`${ROOM_PAGE_LOGIC}; return { pickLang, fitLine };`)() as {
  pickLang(prefs: string[], languages: string[], saved: string | null): string;
  fitLine(text: string, maxWidth: number, basePx: number, measure: Measure): Fit;
};
const { pickLang, fitLine } = logic;

/** Monospace stand-in: every character is 0.5 em wide. */
const mono: Measure = (s, px) => s.length * px * 0.5;

describe('room page: default language', () => {
  it('uses the browser language when the room publishes it, matching on the primary subtag', () => {
    expect(pickLang(['en-US', 'pt-BR'], ['en', 'es'], null)).toBe('en');
    expect(pickLang(['es-419'], ['en', 'es'], null)).toBe('es');
    expect(pickLang(['fr-FR', 'es'], ['en', 'es'], null)).toBe('es');
    expect(pickLang(['pt-BR'], ['en', 'pt-BR'], null)).toBe('pt-BR');
  });

  it('falls back to the first target language — never to the original while the room has translations', () => {
    // Portuguese viewer, Portuguese speaker: the old page opened on "Original (Português)".
    expect(pickLang(['pt-BR', 'pt'], ['en', 'es'], null)).toBe('en');
    expect(pickLang([], ['es', 'en'], null)).toBe('es');
    expect(pickLang([''], ['es'], null)).toBe('es');
  });

  it('uses the original only when the room has no translations', () => {
    expect(pickLang(['en-US'], [], null)).toBe('orig');
  });

  it("keeps the viewer's saved choice while the room still offers it", () => {
    expect(pickLang(['en-US'], ['en', 'es'], 'es')).toBe('es');
    expect(pickLang(['en-US'], ['en', 'es'], 'orig')).toBe('orig');
    expect(pickLang(['en-US'], ['en', 'es'], 'de')).toBe('en');
  });
});

describe('room page: one-line fit of the live line', () => {
  it('keeps the base size when the line fits', () => {
    expect(fitLine('Revenue grew.', 400, 30, mono)).toEqual({ px: 30, text: 'Revenue grew.' });
  });

  it('shrinks the font (not below 70 %) before cutting anything', () => {
    const text = 'a'.repeat(30); // 450 px at 30 px, 315 px at 21 px
    const r = fitLine(text, 400, 30, mono);
    expect(r.text).toBe(text);
    expect(r.px).toBeLessThan(30);
    expect(r.px).toBeGreaterThanOrEqual(21);
    expect(mono(r.text, r.px)).toBeLessThanOrEqual(400);
    expect(fitLine(text, 315, 30, mono)).toEqual({ px: 21, text });
  });

  it('then keeps the END of the sentence behind "…", at 70 % of the size', () => {
    const text = 'Revenue grew eleven percent in the last quarter thanks to the new partnerships';
    const r = fitLine(text, 200, 30, mono);
    expect(r.px).toBe(21);
    expect(r.text.startsWith('…')).toBe(true);
    expect(text.endsWith(r.text.slice(1))).toBe(true);
    expect(r.text.endsWith('partnerships')).toBe(true);
    expect(mono(r.text, r.px)).toBeLessThanOrEqual(200);
    // As many words as fit: one more word from the start would not.
    const words = r.text.slice(1).split(' ');
    const before = text.split(' ')[text.split(' ').length - words.length - 1];
    expect(mono(`…${before} ${words.join(' ')}`, r.px)).toBeGreaterThan(200);
  });

  it('cuts inside a single word that is too long, still keeping its end', () => {
    const r = fitLine('Donaudampfschifffahrtsgesellschaft', 100, 20, mono);
    expect(r.px).toBe(14);
    expect(r.text).toMatch(/^….*gesellschaft$/);
    expect(mono(r.text, r.px)).toBeLessThanOrEqual(100);
  });

  it('collapses whitespace (never more than one line) and leaves unmeasured elements alone', () => {
    expect(fitLine('a\n b', 400, 30, mono).text).toBe('a b');
    expect(fitLine('long text here', 0, 30, mono)).toEqual({ px: 30, text: 'long text here' });
  });

  it('ships the same logic inside the room page', () => {
    const { html } = roomPage('ABC123', { basePath: '/', retentionDays: 30 });
    expect(html).toContain(ROOM_PAGE_LOGIC.trim());
    expect(html).toContain('pickLang(prefs,room.languages');
    expect(html).toContain("addEventListener('orientationchange'");
    expect(html).toContain('measureText');
  });
});
