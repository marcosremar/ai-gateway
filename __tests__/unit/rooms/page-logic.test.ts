/**
 * Pure logic of the live room page (src/rooms/page.ts → ROOM_PAGE_LOGIC): default language choice and the one-line fit
 * of the live line. The same source string that ships inside the page is evaluated here.
 */
import { describe, expect, it } from 'vitest';
import { Script, createContext } from 'vm';
import { ROOM_PAGE_LOGIC, UI_LANGS, UI_TEXT, roomPage } from '../../../src/rooms/page';

interface Fit { px: number; text: string }
type Measure = (s: string, px: number) => number;
interface Settings { ui: string; mode: string; showOrig: boolean; volume: number; sync: boolean; size: number; theme: string; autoScroll: boolean; showTimes: boolean; showDelay: boolean }
interface LiveEntry { id: number; arrivedAt: number; startedAt: number | null; pending: boolean; skip: boolean }
const logic = new Script(`${ROOM_PAGE_LOGIC}; ({ pickLang, fitLine, pickLive, nextStart, backlogDrop, median, delayLabel, normalizeSettings, parseSettings, textSizes, lineView, uaInfo, refOf, wordStarts, spokenCount, speechMs })`)
  .runInContext(createContext({})) as {
  pickLang(prefs: string[], languages: string[], saved: string | null): string;
  fitLine(text: string, maxWidth: number, basePx: number, measure: Measure): Fit;
  pickLive(entries: LiveEntry[], now: number, dubOn: boolean, waitMs: number): number | null;
  nextStart(now: number, prevEnd: number, lead: number): number;
  backlogDrop(ahead: number, durs: number[], maxSec: number): number;
  median(values: number[]): number | null;
  delayLabel(ms: number, voice: boolean, L: Record<string, string>): { text: string; level: 'ok' | 'warn' | 'bad' };
  normalizeSettings(raw: unknown): Settings;
  parseSettings(json: string | null, legacyOrig: string | null): Settings;
  textSizes(step: number, vw: number): { live: number; tx: number };
  lineView(mode: string, showOrig: boolean, lang: string, hasTr: boolean): { main: 'tr' | 'orig'; sub: boolean; miss: boolean };
  uaInfo(ua: string, touch: number): { ua: string; os: string; device: string };
  refOf(search: string, referrer: string): string;
  wordStarts(text: string, start: number, dur: number): number[];
  spokenCount(starts: number[], t: number): number;
  speechMs(text: string): number;
};
const { pickLang, fitLine, pickLive, nextStart, backlogDrop, median, delayLabel, normalizeSettings, parseSettings, textSizes, lineView, uaInfo, refOf, wordStarts, spokenCount, speechMs } = logic;

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
    expect(html).toContain('pickLive(entries,now(),syncOn()');
    expect(html).toContain('createGain');
    expect(html).not.toContain('new Audio(');
  });

  it('keeps the original single-line page features', () => {
    const { html } = roomPage('ABC123', { basePath: '/', retentionDays: 30 });
    expect(html).toContain(ROOM_PAGE_LOGIC.trim());
    expect(html).toContain('pickLang(prefs,room.languages');
    expect(html).toContain("addEventListener('orientationchange'");
    expect(html).toContain('measureText');
  });
});

const entry = (id: number, e: Partial<LiveEntry> = {}): LiveEntry => ({ id, arrivedAt: 0, startedAt: null, pending: false, skip: false, ...e });

describe('room page: live line in sync with the dubbing', () => {
  it('shows the newest line as it arrives when dubbing is off', () => {
    expect(pickLive([entry(1), entry(3, { pending: true }), entry(2)], 0, false, 4000)).toBe(3);
    expect(pickLive([], 0, false, 4000)).toBeNull();
  });

  it('switches to line N when the clip of line N starts playing, not when its text arrives', () => {
    const lines = [entry(1, { arrivedAt: 0, startedAt: 500 }), entry(2, { arrivedAt: 1000, pending: true })];
    expect(pickLive(lines, 1200, true, 4000)).toBe(1); // 2 arrived, its clip is still being decoded/queued
    lines[1] = entry(2, { arrivedAt: 1000, startedAt: 2500 }); // scheduled to start at 2500
    expect(pickLive(lines, 2499, true, 4000)).toBe(1);
    expect(pickLive(lines, 2500, true, 4000)).toBe(2);
    // A queued clip keeps waiting past the no-audio timeout: the voice decides.
    expect(pickLive([entry(1, { startedAt: 500 }), entry(2, { arrivedAt: 1000, pending: true })], 9000, true, 4000)).toBe(1);
  });

  it('still shows lines that never get audio, after the wait, so the screen never freezes', () => {
    const lines = [entry(1, { arrivedAt: 0, startedAt: 100 }), entry(2, { arrivedAt: 1000 })];
    expect(pickLive(lines, 4999, true, 4000)).toBe(1);
    expect(pickLive(lines, 5000, true, 4000)).toBe(2);
  });

  it('follows the most recent event: a later clip start wins over an earlier timeout, dropped clips are skipped', () => {
    const lines = [entry(5, { arrivedAt: 0, startedAt: 6000 }), entry(6, { arrivedAt: 1000 })];
    expect(pickLive(lines, 5500, true, 4000)).toBe(6); // 6 timed out at 5000, 5's voice not started yet
    expect(pickLive(lines, 6000, true, 4000)).toBe(5); // 5's voice starts: the card follows the voice
    expect(pickLive([entry(1, { startedAt: 100 }), entry(2, { arrivedAt: 0, skip: true })], 9e9, true, 4000)).toBe(1);
  });

  it('returns null when nothing is eligible yet (the page keeps what it shows)', () => {
    expect(pickLive([entry(1, { arrivedAt: 1000, pending: true })], 2000, true, 4000)).toBeNull();
  });
});

describe('room page: clip scheduling', () => {
  it('schedules clips back to back, never overlapping, never in the past', () => {
    expect(nextStart(10, 0, 0.05)).toBeCloseTo(10.05);
    expect(nextStart(10, 12.3, 0.05)).toBe(12.3);
    expect(nextStart(10, 10.01, 0.05)).toBeCloseTo(10.05);
  });

  it('drops the oldest pending clips when more than the limit is still to play, keeping the newest', () => {
    expect(backlogDrop(1, [2, 2], 6)).toBe(0);
    expect(backlogDrop(3, [2, 2, 2], 6)).toBe(2); // 9 s → drop two oldest → 5 s
    expect(backlogDrop(0, [10], 6)).toBe(0); // never drops the newest
    expect(backlogDrop(-5, [3, 3], 6)).toBe(0); // queue already drained: ahead counts as 0
  });
});

describe('room page: delay indicator', () => {
  it('uses the median of the values', () => {
    expect(median([])).toBeNull();
    expect(median([5000, 1000, 2000])).toBe(2000);
    expect(median([1000, 2000, 3000, 9000])).toBe(2500);
  });

  it('labels in the interface language with one decimal and colors by threshold', () => {
    expect(delayLabel(1849, false, UI_TEXT.fr)).toEqual({ text: 'délai 1,8 s', level: 'ok' });
    expect(delayLabel(1849, false, UI_TEXT.en)).toEqual({ text: 'delay 1.8 s', level: 'ok' });
    expect(delayLabel(1849, false, UI_TEXT.pt)).toEqual({ text: 'atraso 1,8 s', level: 'ok' });
    expect(delayLabel(3200, true, UI_TEXT.pt)).toEqual({ text: 'voz 3,2 s', level: 'warn' });
    expect(delayLabel(2999, false, UI_TEXT.pt).level).toBe('ok');
    expect(delayLabel(6000, false, UI_TEXT.pt).level).toBe('warn');
    expect(delayLabel(6001, false, UI_TEXT.pt).level).toBe('bad');
  });
});
const DEFAULTS: Settings = { ui: 'fr', mode: 'translation', showOrig: false, volume: 0.9, sync: true, size: 0, theme: 'auto', autoScroll: true, showTimes: true, showDelay: true };

describe('room page: viewer settings', () => {
  it('defaults: translation, original hidden, voice sync on, automatic theme, auto-scroll, times and delay shown', () => {
    expect({ ...parseSettings(null, null) }).toEqual(DEFAULTS);
    expect({ ...parseSettings('not json', null) }).toEqual(DEFAULTS);
    expect({ ...parseSettings('[1,2]', null) }).toEqual(DEFAULTS);
  });

  it('round-trips a saved choice and validates every field independently', () => {
    const saved: Settings = { ui: 'en', mode: 'bilingual', showOrig: true, volume: 0.35, sync: false, size: 4, theme: 'light', autoScroll: false, showTimes: false, showDelay: false };
    expect({ ...parseSettings(JSON.stringify(saved), null) }).toEqual(saved);
    const bad = { mode: 'karaoke', theme: 'pink', volume: 3, size: 99, sync: 'yes', showTimes: 0, autoScroll: false };
    expect({ ...normalizeSettings(bad) }).toEqual({ ...DEFAULTS, size: 7, autoScroll: false });
    expect(normalizeSettings({ size: -50 }).size).toBe(-3);
    expect(normalizeSettings({ size: 1.6 }).size).toBe(2);
  });

  it('keeps honouring the older "ucast-orig" flag until the viewer chooses', () => {
    expect(parseSettings(null, '1').showOrig).toBe(true);
    expect(parseSettings('{"showOrig":false}', '1').showOrig).toBe(false);
  });

  it('bounds the text size: live line 20–56 px, transcript 14–24 px', () => {
    expect(textSizes(0, 412)).toEqual({ live: 32, tx: 17 });
    expect(textSizes(-3, 320)).toEqual({ live: 20, tx: 14 });
    expect(textSizes(7, 1280)).toEqual({ live: 56, tx: 24 });
    expect(textSizes(-99, 200).live).toBe(20);
    expect(textSizes(99, 4000).tx).toBe(24);
  });

  it('decides what a line shows in each mode', () => {
    expect({ ...lineView('translation', false, 'en', true) }).toEqual({ main: 'tr', sub: false, miss: false });
    expect({ ...lineView('translation', true, 'en', true) }).toEqual({ main: 'tr', sub: true, miss: false });
    expect({ ...lineView('bilingual', false, 'en', true) }).toEqual({ main: 'tr', sub: true, miss: false });
    expect({ ...lineView('transcript', true, 'en', true) }).toEqual({ main: 'orig', sub: false, miss: false });
    expect({ ...lineView('full', true, 'en', true) }).toEqual({ main: 'tr', sub: true, miss: false });
    expect({ ...lineView('translation', true, 'orig', false) }).toEqual({ main: 'orig', sub: false, miss: false });
    expect({ ...lineView('bilingual', false, 'en', false) }).toEqual({ main: 'orig', sub: false, miss: true });
  });

  it('ships an accessible settings sheet', () => {
    const { html } = roomPage('ABC123', { basePath: '/', retentionDays: 30 });
    for (const s of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby="sheetTitle"', 'aria-haspopup="dialog"', "e.key==='Escape'", "localStorage.setItem",
      'Transcription seule', 'Bilingue', 'Texte complet seul', 'Synchroniser les sous-titres avec la voix', 'Défilement automatique du texte complet', 'Afficher les heures', 'Afficher le délai', 'Automatique']) {
      expect(html).toContain(s);
    }
    expect(html).not.toMatch(/ style="/); // CSP: no inline style attributes
  });
});
describe('room page: analytics helpers', () => {
  it('reduces the user agent to browser family, OS and device class', () => {
    const cases: Array<[string, number, { ua: string; os: string; device: string }]> = [
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36', 5, { ua: 'chrome', os: 'android', device: 'mobile' }],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 5, { ua: 'safari', os: 'ios', device: 'mobile' }],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1', 5, { ua: 'chrome', os: 'ios', device: 'mobile' }],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5, { ua: 'safari', os: 'ios', device: 'tablet' }],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0', 0, { ua: 'edge', os: 'windows', device: 'desktop' }],
      ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36', 5, { ua: 'samsung', os: 'android', device: 'mobile' }],
      ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 0, { ua: 'firefox', os: 'linux', device: 'desktop' }],
      ['', 0, { ua: 'other', os: 'other', device: 'desktop' }],
    ];
    for (const [ua, touch, want] of cases) expect({ ...uaInfo(ua, touch) }).toEqual(want);
  });

  it('classifies how the viewer arrived', () => {
    expect(refOf('?src=qr', '')).toBe('qr');
    expect(refOf('?x=1&ref=QR', 'https://x')).toBe('qr');
    expect(refOf('', 'https://wa.me/')).toBe('link');
    expect(refOf('', '')).toBe('direct');
  });

  it('ships the batched, anonymous event reporting', () => {
    const { html } = roomPage('ABC123', { basePath: '/', retentionDays: 30 });
    for (const s of ["navigator.sendBeacon", "'/v1/rooms/'+CODE+'/events'", "addEventListener('pagehide'", "store.get('ucast-viewer')", "track('join'", "track('setting'", "track('sample'", "track('leave'", "store.set('ucast-lang-last'"]) {
      expect(html).toContain(s);
    }
  });
});

describe('room page: karaoke highlight', () => {
  it('marks the words whose start time has passed, never skipping or going back', () => {
    const starts = wordStarts('and I started to feel sick', 1000, 2600);
    expect(starts).toHaveLength(6);
    expect(starts[0]).toBe(1000);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    expect(starts[5]).toBeLessThan(3600);
    expect(spokenCount(starts, 999)).toBe(0);
    expect(spokenCount(starts, 1000)).toBe(1); // "and"
    expect(spokenCount(starts, starts[3])).toBe(4); // "to" starts now
    expect(spokenCount(starts, starts[3] - 1)).toBe(3);
    expect(spokenCount(starts, 1e12)).toBe(6);
    let last = 0;
    for (let t = 900; t <= 3700; t += 37) { const k = spokenCount(starts, t); expect(k).toBeGreaterThanOrEqual(last); last = k; }
  });

  it('spreads words by length and estimates speech time from the text', () => {
    const s = wordStarts('a bbbbbbbbb c', 0, 1400);
    expect(s[1] - s[0]).toBeLessThan(s[2] - s[1]); // the long word takes longer
    expect(wordStarts('', 0, 1000)).toEqual([]);
    expect(speechMs('and I started to feel sick')).toBeCloseTo(26 * 1000 / 15);
    expect(speechMs('ok')).toBe(800);
  });

  it('ships the karaoke painting in the page', () => {
    const { html } = roomPage('ABC123', { basePath: '/', retentionDays: 30 });
    for (const s of ['function paintKaraoke', 'spokenCount(wordStarts(text,start,dur),now())', 'm.durMs=dur*1000', '.k{color:var(--accent)']) expect(html).toContain(s);
  });
});

describe('room page: interface language and per-app settings', () => {
  it('defaults the interface to French, accepts pt and en, rejects the rest', () => {
    expect(parseSettings(null, null).ui).toBe('fr');
    expect(normalizeSettings({ ui: 'en' }).ui).toBe('en');
    expect(normalizeSettings({ ui: 'pt' }).ui).toBe('pt');
    expect(normalizeSettings({ ui: 'de' }).ui).toBe('fr');
  });

  it('renders in French and keeps settings under the key of the app that opened the live', () => {
    const { html } = roomPage('ABC123', { basePath: '/', retentionDays: 30 }, 'a1b2c3d4e5f6');
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('Réglages d&#39;affichage');
    expect(html).toContain('APP="a1b2c3d4e5f6"');
    expect(html).toContain("SETTINGS_KEY='ucast-settings-'+APP");
    expect(html).toContain('store.set(SETTINGS_KEY,');
  });

  it('has every interface string in every language', () => {
    const keys = Object.keys(UI_TEXT.fr).sort();
    for (const l of UI_LANGS) expect(Object.keys(UI_TEXT[l]).sort()).toEqual(keys);
    const { html } = roomPage('ABC123', { basePath: '/', retentionDays: 30 });
    for (const k of html.matchAll(/data-ia?="(\w+)"/g)) expect(UI_TEXT.fr[k[1]]).toBeTypeOf('string');
  });

  it('shows the quick mode buttons with accessible names and a gear', () => {
    const { html } = roomPage('ABC123', { basePath: '/', retentionDays: 30 });
    for (const m of ['dub', 'translation', 'bilingual', 'transcript', 'full']) expect(html).toMatch(new RegExp(`data-m="${m}" aria-pressed="false" data-ia="\\w+" data-tip="[^"]+" aria-label="[^"]+"`));
    expect(html).toContain('id="gear"');
  });
});
