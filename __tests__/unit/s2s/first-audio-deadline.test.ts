import { describe, expect, it } from 'vitest';
import { runComposite, type S2SConfig } from '../../../src/s2s/composite';
import type { S2SEvent } from '../../../src/s2s/frames';
import { fakeStages, sleep, type FakeStagesOptions } from './_fakes';

const OPENERS = ['Hum, deixa eu ver.', 'Só um instante.'];
const REPLY = 'Bom dia, querida!Aqui está o seu pão.';
let voices = 0;
const freshVoice = () => `voice-${++voices}`;

async function run(config: S2SConfig, o: FakeStagesOptions = {}, extra: Partial<Parameters<typeof runComposite>[0]> = {}) {
  const { stages, calls } = fakeStages(o);
  const events: Array<S2SEvent & { at: number }> = [];
  const audio: Uint8Array[] = [];
  const t0 = performance.now();
  const result = await runComposite({
    stages, audio: new Uint8Array([1, 2, 3]), contentType: 'audio/webm', config: { language: 'pt', ...config },
    signal: new AbortController().signal, deadlineMs: 160, marginMs: 60,
    emitEvent: e => events.push({ ...e, at: Math.round(performance.now() - t0) }), emitAudio: a => audio.push(a), ...extra,
  });
  const types = events.map(e => (e.type === 'opener' ? `opener:${String(e.state)}` : e.type));
  return { result, events, types, voiced: new TextDecoder().decode(Buffer.concat(audio.map(a => Buffer.from(a)))), calls, done: events[events.length - 1] };
}

const openerCalls = (calls: Array<{ stage: string; text?: string }>) => calls.filter(c => c.stage === 'tts' && OPENERS.includes(c.text ?? ''));

describe('runComposite: first-audio deadline and opener', () => {
  it('reply in time: no opener; the lines were synthesized ahead; done reports the deadline and the first sound', async () => {
    const { types, voiced, calls, done } = await run({ voice: freshVoice(), opener: { lines: OPENERS } }, {}, { deadlineMs: 2_000 });
    expect(types).not.toContain('opener:start');
    expect(types).not.toContain('deadline_missed');
    expect(voiced).toBe(REPLY);
    expect(openerCalls(calls).map(c => c.text).sort()).toEqual([...OPENERS].sort());
    expect(done).toMatchObject({ type: 'done', opener: null, deadline_missed: false, deadline_ms: 2_000, endpoint_ms: 0 });
    expect(done.first_sound_ms).toBe(done.first_audio_ms);
  });

  it('reply late: one opener at the deadline minus the margin, then the reply, in order and never twice', async () => {
    const { types, events, voiced, done } = await run({ voice: freshVoice(), opener: { lines: OPENERS } }, { sttMs: 250 });
    expect(types).toEqual([
      'audio_format', 'opener:start', 'opener:end', 'transcript', 'llm_first_token', 'sentence', 'audio_format', 'first_audio', 'sentence_end',
      'sentence', 'sentence_end', 'done',
    ]);
    expect(voiced).toBe(OPENERS[0] + REPLY);
    const start = events[1];
    expect(start).toMatchObject({ text: OPENERS[0], index: 0, audio_ms: Math.round((new TextEncoder().encode(OPENERS[0]).length / 2 / 24_000) * 1000) });
    expect(start.at).toBeGreaterThanOrEqual(95);
    expect(start.at).toBeLessThan(160);
    expect(events[0]).toMatchObject({ encoding: 'pcm_s16le', sample_rate: 24_000 });
    expect(done).toMatchObject({ opener: OPENERS[0], deadline_missed: false });
    expect(done.first_sound_ms as number).toBeLessThan(done.first_audio_ms as number);
  });

  it('cache: a second turn with the same voice and lines synthesizes nothing; another voice does', async () => {
    const voice = freshVoice();
    await run({ voice, opener: { lines: OPENERS } }, {}, { deadlineMs: 2_000 });
    const second = await run({ voice, opener: { lines: OPENERS } }, { sttMs: 250 });
    expect(openerCalls(second.calls)).toEqual([]);
    expect(second.types).toContain('opener:start');
    const other = await run({ voice: freshVoice(), opener: { lines: OPENERS } }, {}, { deadlineMs: 2_000 });
    expect(openerCalls(other.calls).length).toBe(2);
  });

  it('rotation: the line follows the turn number of the conversation', async () => {
    const voice = freshVoice();
    const history = [{ role: 'user', content: 'Oi.' }, { role: 'assistant', content: 'Olá!' }];
    const first = await run({ voice, opener: { lines: OPENERS } }, { sttMs: 250 });
    const second = await run({ voice, opener: { lines: OPENERS }, messages: history }, { sttMs: 250 });
    expect([first.done.opener, second.done.opener]).toEqual(OPENERS);
    expect(second.events.find(e => e.type === 'opener')).toMatchObject({ index: 1 });
  });

  it('no opener configured: none is played, deadline_missed is reported at the deadline', async () => {
    const { types, events, voiced, done } = await run({ voice: freshVoice() }, { sttMs: 250 });
    expect(types[0]).toBe('deadline_missed');
    expect(types).not.toContain('opener:start');
    expect(events[0]).toMatchObject({ deadline_ms: 160 });
    expect(events[0].at).toBeGreaterThanOrEqual(155);
    expect(voiced).toBe(REPLY);
    expect(done).toMatchObject({ opener: null, deadline_missed: true });
  });

  it('endpoint_ms moves the deadline back to the end of the speech; the session may shorten it, never beyond 2500', async () => {
    const voice = freshVoice();
    await run({ voice, opener: { lines: OPENERS } }, {}, { deadlineMs: 2_000 });
    const early = await run({ voice, opener: { lines: OPENERS }, endpoint_ms: 80 }, { sttMs: 250 });
    expect(early.events[1].at).toBeLessThan(80);
    expect(early.done).toMatchObject({ endpoint_ms: 80 });
    const asked = await run({ voice, first_audio_deadline_ms: 9_000 });
    expect(asked.done).toMatchObject({ deadline_ms: 2_500 });
  });

  it('a turn cancelled before the deadline plays no opener; a hedge or a resumed turn (skipDeadline) never does', async () => {
    const voice = freshVoice();
    await run({ voice, opener: { lines: OPENERS } }, {}, { deadlineMs: 2_000 });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);
    const cancelled = await run({ voice, opener: { lines: OPENERS } }, { sttMs: 250 }, { signal: abort.signal });
    expect(cancelled.types).not.toContain('opener:start');
    const resumed = await run({ voice, opener: { lines: OPENERS } }, { sttMs: 250 }, { skipDeadline: true });
    expect(resumed.types).not.toContain('opener:start');
    expect(resumed.types).not.toContain('deadline_missed');
  });

  it('an opener that failed to synthesize is not cached: deadline_missed now, synthesized again next turn', async () => {
    const voice = freshVoice();
    const failed = await run({ voice, opener: { lines: [OPENERS[0]] } }, { sttMs: 250, failTtsFor: 'Hum' });
    expect(failed.types).not.toContain('opener:start');
    expect(failed.done).toMatchObject({ deadline_missed: true });
    const next = await run({ voice, opener: { lines: [OPENERS[0]] } }, { sttMs: 250 });
    expect(openerCalls(next.calls).length).toBe(1);
    expect(next.done).toMatchObject({ opener: OPENERS[0] });
  });

  it('an MP3 opener keeps its format: announced before it, and the PCM reply announces its own again', async () => {
    const { events, types } = await run({ voice: freshVoice(), opener: { lines: [OPENERS[0]] } }, { sttMs: 250, mp3For: 'Hum' });
    expect(types.slice(0, 3)).toEqual(['audio_format', 'opener:start', 'opener:end']);
    expect(events[0]).toMatchObject({ encoding: 'audio/mpeg', provider: 'openrouter:mai-tts' });
    expect(events[1]).toMatchObject({ audio_ms: null });
    expect(events.filter(e => e.type === 'audio_format')[1]).toMatchObject({ encoding: 'pcm_s16le' });
  });

  it('the first clause is sent to the TTS while the LLM is still answering', async () => {
    const { calls } = await run({ voice: freshVoice() }, { tokenMs: 10 }, { deadlineMs: 2_000 });
    const firstTts = calls.find(c => c.stage === 'tts')!;
    expect(firstTts.text).toBe('Bom dia, querida!');
    expect(firstTts.at - calls.find(c => c.stage === 'llm')!.at).toBeLessThan(REPLY.length / 3 * 10 - 40);
  });

  it('stage budget: with a deadline or an opener each stage call carries the time left to the deadline, at least 1 s', async () => {
    const enforced = await run({ voice: freshVoice(), first_audio_deadline_ms: 2_000, endpoint_ms: 700 }, { sttMs: 30 });
    const stt = enforced.calls.find(c => c.stage === 'stt')!;
    expect(stt.hedgeMs).toBeGreaterThan(1_250);
    expect(stt.hedgeMs).toBeLessThanOrEqual(1_300);
    const llm = enforced.calls.find(c => c.stage === 'llm')!;
    expect(llm.hedgeMs).toBeLessThan(stt.hedgeMs as number);
    expect(llm.hedgeMs).toBeGreaterThanOrEqual(1_000);
    const late = await run({ voice: freshVoice(), first_audio_deadline_ms: 500 }, { sttMs: 30 });
    expect(late.calls.map(c => c.hedgeMs)).toEqual(late.calls.map(() => 1_000));
    const plain = await run({ voice: freshVoice() });
    expect(plain.calls.every(c => c.hedgeMs === undefined)).toBe(true);
    await sleep(0);
  });
});
