import { describe, expect, it } from 'vitest';
import { runComposite, WavStripper } from '../../../src/s2s/composite';
import type { S2SEvent } from '../../../src/s2s/frames';
import { fakeStages, wav } from './_fakes';

async function run(o: Parameters<typeof fakeStages>[0] = {}, extra: Partial<Parameters<typeof runComposite>[0]> = {}) {
  const { stages, calls } = fakeStages(o);
  const events: S2SEvent[] = [];
  const audio: Uint8Array[] = [];
  const result = await runComposite({
    stages, audio: new Uint8Array([1, 2, 3]), contentType: 'audio/webm', config: { system: 'Você é o Seu Jorge.', voice: 'br-m-08', language: 'pt' },
    signal: new AbortController().signal, emitEvent: e => events.push(e), emitAudio: a => audio.push(a), ...extra,
  });
  return { result, events, voiced: new TextDecoder().decode(Buffer.concat(audio.map(a => Buffer.from(a)))), calls };
}

describe('runComposite', () => {
  it('chains STT → streamed LLM → TTS per sentence, in speaking order, WAV header stripped', async () => {
    const { result, events, voiced, calls } = await run();
    expect(events.map(e => e.type)).toEqual([
      'transcript', 'llm_first_token', 'sentence', 'audio_format', 'first_audio', 'sentence', 'done',
    ]);
    expect(events.filter(e => e.type === 'sentence').map(e => e.text)).toEqual(['Bom dia, querida!', 'Aqui está o seu pão.']);
    expect(voiced).toBe('Bom dia, querida!Aqui está o seu pão.'); // PCM only, no RIFF header bytes
    expect(events.find(e => e.type === 'audio_format')).toMatchObject({ encoding: 'pcm_s16le', sample_rate: 24_000 });
    expect(result).toMatchObject({ transcript: 'Bom dia, eu queria um pão.', missingAudio: 0 });
    // The LLM got the system prompt, then the heard text as the user turn
    expect(calls.find(c => c.stage === 'llm')?.text).toBe('Bom dia, eu queria um pão.');
    // Who served each stage is reported
    expect(events[0]).toMatchObject({ provider: 'deployment:parle-speech' });
    expect(events[1]).toMatchObject({ provider: 'openrouter:qwen/qwen3.5-9b', fallback: 'cold' });
  });

  it('starts the next sentence\'s TTS while the first is still being voiced (2 ahead)', async () => {
    const { calls } = await run({ reply: 'Bom dia, querida! Aqui está. Mais alguma coisa? Até logo!', ttsMs: 30, tokenMs: 0 });
    const tts = calls.filter(c => c.stage === 'tts');
    expect(tts.length).toBe(4);
    expect(tts[1].at - tts[0].at).toBeLessThan(25); // second started before the first finished (30 ms)
  });

  it('a sentence whose TTS fails is reported and skipped; the rest is still voiced', async () => {
    const { events, voiced, result } = await run({ failTtsFor: 'Aqui' });
    expect(events.find(e => e.type === 'sentence_failed')).toMatchObject({ text: 'Aqui está o seu pão.' });
    expect(voiced).toBe('Bom dia, querida!');
    expect(result.missingAudio).toBe(1);
    expect(events[events.length - 1]).toMatchObject({ type: 'done', missing_audio: 1 });
  });

  it('resumes from a known transcript without a second STT', async () => {
    const { calls, events } = await run({}, { transcript: { text: 'Oi, tudo bem?' } });
    expect(calls.some(c => c.stage === 'stt')).toBe(false);
    expect(calls.find(c => c.stage === 'llm')?.text).toBe('Oi, tudo bem?');
    expect(events.some(e => e.type === 'transcript')).toBe(false);
  });

  it('empty transcript: done at once, no LLM call', async () => {
    const { calls, events } = await run({ heard: '  ' });
    expect(calls.map(c => c.stage)).toEqual(['stt']);
    expect(events[events.length - 1]).toMatchObject({ type: 'done', empty: true });
  });

  it('LLM breaks after a sentence: that sentence is voiced, then a partial error and done', async () => {
    const { events, voiced } = await run({ breakLlmAfter: 7 });
    expect(voiced).toBe('Bom dia, querida!');
    expect(events.find(e => e.type === 'error')).toMatchObject({ stage: 'llm', partial: true });
    expect(events[events.length - 1].type).toBe('done');
  });

  it('LLM breaks before anything to say: the error reaches the caller (the route can still answer 503)', async () => {
    await expect(run({ breakLlmAfter: 0 })).rejects.toThrow(/llm stream broke/);
  });

  it('STT failure reaches the caller', async () => {
    await expect(run({ failSttWith: 'stt HTTP 503: no provider' })).rejects.toThrow(/stt HTTP 503/);
  });
});

describe('WavStripper', () => {
  it('strips a header split across chunks and reads the sample rate', () => {
    const bytes = wav(new Uint8Array([9, 8, 7, 6]), 22_050);
    const s = new WavStripper();
    const out = [s.push(bytes.slice(0, 10)), s.push(bytes.slice(10, 40)), s.push(bytes.slice(40))];
    expect(Array.from(Buffer.concat(out.map(b => Buffer.from(b))))).toEqual([9, 8, 7, 6]);
    expect(s.sampleRate).toBe(22_050);
  });

  it('passes raw PCM through', () => {
    const s = new WavStripper();
    expect(Array.from(s.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])))).toHaveLength(13);
  });
});

describe('runComposite with speak_field (JSON answers)', () => {
  it('voices only the field, as it streams; the whole JSON comes back in done.reply_raw', async () => {
    const json = '{"utterance": "Bom dia, querida! Aqui está.", "end": false, "mood": "warm"}';
    const { events, voiced, calls } = await run({ reply: json }, {
      config: { voice: 'br-m-08', speak_field: 'utterance', response_format: { type: 'json_object' } },
    });
    expect(voiced).toBe('Bom dia, querida!Aqui está.');
    const done = events[events.length - 1];
    expect(done).toMatchObject({ type: 'done', reply: 'Bom dia, querida! Aqui está.', reply_raw: json });
    expect(calls.find(c => c.stage === 'llm')?.cfg?.response_format).toEqual({ type: 'json_object' });
  });
});
