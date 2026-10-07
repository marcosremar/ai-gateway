import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeLanguage, resetBlocklistForTests } from '../../../src/stt-hallucination-filter';

const root = join(__dirname, '../../..');

describe('stt filter blocklist shipping', () => {
  afterEach(() => {
    delete process.env.STT_FILTER_LANGUAGES;
    resetBlocklistForTests();
  });

  it('compiles in only the core languages (the full 316 KB file stays out of the bundles)', () => {
    const core = JSON.parse(readFileSync(join(root, 'src/data/whisper-hallucinations.core.json'), 'utf8'));
    expect(Object.keys(core).sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'pt']);
    const src = readFileSync(join(root, 'src/stt-hallucination-filter.ts'), 'utf8');
    expect(src).not.toMatch(/import [^;]*['"]\.\/data\/whisper-hallucinations\.json['"]/);
  });

  it('knows core languages by default and extra ones only with STT_FILTER_LANGUAGES=all', () => {
    expect(normalizeLanguage('pt-BR')).toBe('pt');
    expect(normalizeLanguage('xx')).toBeUndefined();
    process.env.STT_FILTER_LANGUAGES = 'all';
    resetBlocklistForTests();
    expect(normalizeLanguage('ar')).toBe('ar');
  });
});
