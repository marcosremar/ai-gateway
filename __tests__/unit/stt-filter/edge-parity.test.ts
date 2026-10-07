/**
 * The realtime edge (docker/aigw-edge, Python) carries a port of the STT hallucination filter and a copy of the core
 * blocklist. This keeps the two from drifting: same blocklist file, and the same verdict (kept text + reason codes) on
 * every case of the TS suite, the 220+ A1 learner utterances, the core blocklist itself and metadata-only cases.
 * Skipped when python3 is not installed (the port is standard-library only).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterHallucinations } from '../../../src/stt-hallucination-filter';
import core from '../../../src/data/whisper-hallucinations.core.json';
import utterances from './a1-utterances.json';

const ROOT = join(__dirname, '..', '..', '..');
const EDGE = join(ROOT, 'docker', 'aigw-edge', 'aigw_edge');
const hasPython = spawnSync('python3', ['--version']).status === 0;

interface Case { text: string; language: string; meta?: Record<string, number> }

function cases(): Case[] {
  const out: Case[] = [];
  const langName: Record<string, string> = { pt: 'Portuguese', fr: 'French', en: 'English' };
  for (const [lang, list] of Object.entries(utterances as Record<string, string[]>)) {
    const language = lang.startsWith('pt') ? 'pt' : (langName[lang] ? lang : 'pt');
    for (const text of list) out.push({ text, language }, { text, language, meta: { no_speech_prob: 0.05, avg_logprob: -0.35, compression_ratio: 1.3 } });
  }
  for (const [lang, list] of Object.entries(core as Record<string, string[]>)) {
    for (const text of list) out.push({ text, language: lang }, { text, language: lang, meta: { no_speech_prob: 0.5, avg_logprob: -0.3, compression_ratio: 1 } });
  }
  for (const text of [' Legenda por Sônia Ruberti', ' E aí ♫ E aí E aí E aí E aí E aí E aí', 'Legendas por Marcos Silva',
    'Sous-titres réalisés par Jean Dupont', "Sous-titrage ST' 501", 'Subtitles by Jane Doe', 'Subtítulos por la comunidad', '♪ ♪',
    '♪ la la la ♪', '🎵', 'E aí E aí E aí E aí', 'Obrigado. Obrigado. Obrigado. Obrigado.', 'muito bom muito bom muito bom',
    'sim sim', 'não, não', 'sim, sim, sim', 'Thanks for watching', 'Obrigado por assistir!', 'E aí.', 'Merci d\'avoir regardé cette vidéo.']) {
    out.push({ text, language: 'pt' }, { text, language: 'Portuguese' }, { text, language: 'fr' });
  }
  for (const meta of [{ no_speech_prob: 0.9, avg_logprob: -0.5, compression_ratio: 1 }, { no_speech_prob: 0.1, avg_logprob: -0.3, compression_ratio: 3.1 },
    { no_speech_prob: 0.1, avg_logprob: -1.4, compression_ratio: 1 }, { no_speech_prob: 0.45, avg_logprob: -0.3, compression_ratio: 1 }]) {
    for (const text of ['Sim.', 'qualquer coisa', 'eu não sei', 'Eu não sei.']) out.push({ text, language: 'pt', meta });
  }
  return out;
}

describe.skipIf(!hasPython)('edge (Python) hallucination filter = gateway filter', () => {
  it('ships the same core blocklist', () => {
    expect(JSON.parse(readFileSync(join(EDGE, 'whisper-hallucinations.core.json'), 'utf8'))).toEqual(core);
  });

  it('gives the same verdict on every case', () => {
    const all = cases();
    const run = spawnSync('python3', ['-I', join(EDGE, 'hallucination.py')], { input: JSON.stringify(all), encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const py = JSON.parse(run.stdout) as Array<{ text: string; codes: string[] }>;
    const diffs = all.map((c, i) => {
      const ts = filterHallucinations({ text: c.text, ...(c.meta ?? {}) } as never, c.language);
      return ts.text === py[i].text && JSON.stringify(ts.reasonCodes) === JSON.stringify(py[i].codes)
        ? null : { case: c, ts: { text: ts.text, codes: ts.reasonCodes }, py: py[i] };
    }).filter(Boolean);
    expect(all.length).toBeGreaterThan(1000);
    expect(diffs).toEqual([]);
  });
});
