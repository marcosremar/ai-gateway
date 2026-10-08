/**
 * PCM framing and resampling of the WS rung, and the s2s-stream rung reading streamed frames (sdk/browser/realtime).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEOUTS, FrameChunker, LinearResampler, createS2SStreamTransport, decodeAudioFrame, encodeAudioFrame,
  floatToInt16, int16ToFloat, mapS2SEvent, samplesPerFrame, type PcmPlayer, type RealtimeEvent, type TransportContext,
} from '../../sdk/browser/realtime/index';
import { createLocalTelemetry } from '../../sdk/browser/realtime/telemetry';
import { encodeAudio, encodeEvent } from '../../src/s2s/frames';

describe('WS audio frames', () => {
  it('0x01 header + little-endian int16, round trip; other headers and odd lengths are not audio', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 258]);
    const frame = encodeAudioFrame(pcm);
    expect(frame[0]).toBe(0x01);
    expect(Array.from(frame.subarray(1, 5))).toEqual([0, 0, 1, 0]);
    expect(Array.from(frame.subarray(11, 13))).toEqual([2, 1]); // 258 = 0x0102, LE
    expect(Array.from(decodeAudioFrame(frame.buffer as ArrayBuffer)!)).toEqual(Array.from(pcm));
    expect(decodeAudioFrame(new Uint8Array([0x02, 0, 0]))).toBeNull();
    expect(decodeAudioFrame(new Uint8Array([0x01, 0]))).toBeNull();
  });

  it('float ↔ int16 saturates and keeps the sign range', () => {
    expect(Array.from(floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
    const back = int16ToFloat(Int16Array.from([32767, -32768, 0]));
    expect(Array.from(back)).toEqual([1, -1, 0]);
  });

  it('20 ms frames: 320 samples at 16 kHz, 480 at 24 kHz; the chunker keeps the remainder', () => {
    expect(samplesPerFrame(16_000)).toBe(320);
    expect(samplesPerFrame(24_000)).toBe(480);
    const c = new FrameChunker(320);
    expect(c.push(new Float32Array(128))).toHaveLength(0);
    expect(c.push(new Float32Array(128))).toHaveLength(0);
    const frames = c.push(new Float32Array(400)); // 656 → 2 frames, 16 left
    expect(frames.map(f => f.length)).toEqual([320, 320]);
    expect(c.push(new Float32Array(304))).toHaveLength(1);
  });
});

describe('LinearResampler', () => {
  const sine = (n: number, rate: number, hz = 440) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

  it('48 kHz → 16 kHz in render quanta of 128 equals one pass, and the length ratio holds', () => {
    const input = sine(48_000, 48_000);
    const whole = new LinearResampler(48_000, 16_000).push(input);
    const r = new LinearResampler(48_000, 16_000);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 128) parts.push(...r.push(input.subarray(i, i + 128)));
    expect(parts.length).toBe(whole.length);
    expect(Math.abs(parts.length - 16_000)).toBeLessThanOrEqual(1);
    let maxDiff = 0;
    for (let i = 0; i < whole.length; i++) maxDiff = Math.max(maxDiff, Math.abs(parts[i]! - whole[i]!));
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it('24 kHz → 44.1 kHz upsampling stays close to the true signal (speech band)', () => {
    const out = new LinearResampler(24_000, 44_100).push(sine(2400, 24_000, 300));
    const truth = sine(out.length, 44_100, 300);
    let err = 0;
    for (let i = 0; i < out.length; i++) err = Math.max(err, Math.abs(out[i]! - truth[i]!));
    expect(err).toBeLessThan(0.01);
    expect(new LinearResampler(16_000, 16_000).push(Float32Array.from([1, 2]))).toEqual(Float32Array.from([1, 2]));
  });
});

describe('s2s-stream rung', () => {
  function fakePlayer() {
    const pushed: Array<{ samples: number; rate: number }> = [];
    const player: PcmPlayer = {
      pushPcm16: (pcm, rate) => { pushed.push({ samples: pcm.length, rate }); },
      pushFloat: () => {}, flush: () => {}, playing: false, idle: async () => {}, pushEncoded: async () => {}, close: () => {},
    };
    return { pushed, factory: async () => player };
  }

  function ctx(fetchImpl: typeof fetch, events: RealtimeEvent[]): TransportContext {
    const telemetry = createLocalTelemetry({ send: false });
    return {
      descriptor: null, timeouts: DEFAULT_TIMEOUTS, fetchImpl, telemetry, traceparent: telemetry.traceparent,
      mic: async () => ({}) as MediaStream, emit: e => events.push(e), fail: () => {}, remoteAudio: () => {},
      config: () => ({ system: 'S', messages: [] }), dropped: () => {},
    };
  }

  it('posts the clip with config and traceparent, reads binary frames as they stream, plays PCM, maps events', async () => {
    const chunks = [
      encodeEvent({ type: 'route', provider: 'composite', fallback: 'saturated', from: 'deployment:speech' }, 'binary'),
      encodeEvent({ type: 'transcript', text: 'um pão' }, 'binary'),
      encodeEvent({ type: 'sentence', text: 'Claro.' }, 'binary'),
      encodeEvent({ type: 'audio_format', encoding: 'pcm_s16le', sample_rate: 24_000 }, 'binary'),
      encodeAudio(new Uint8Array(960), 'binary'),
      encodeEvent({ type: 'first_audio', at_ms: 400 }, 'binary'),
      encodeAudio(new Uint8Array(480), 'binary'),
      encodeEvent({ type: 'done', reply: 'Claro.', first_audio_ms: 400 }, 'binary'),
    ];
    const wire = Buffer.concat(chunks.map(c => Buffer.from(c)));
    let seen: { url: string; headers: Headers; form: FormData } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), form: init.body as FormData };
      // split mid-frame to prove the decoder is incremental
      const body = new ReadableStream({ start(c) { c.enqueue(wire.subarray(0, 37)); c.enqueue(wire.subarray(37)); c.close(); } });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-aigw-s2s' } });
    }) as unknown as typeof fetch;
    const events: RealtimeEvent[] = [];
    const p = fakePlayer();
    const c = ctx(fetchImpl, events);
    const t = createS2SStreamTransport(c, { url: '/app/s2s' }, p.factory);
    await t.connect(new AbortController().signal);
    await t.sendTurn!(new Blob(['RIFF'], { type: 'audio/wav' }));
    expect(seen!.url).toBe('/app/s2s');
    expect(seen!.headers.get('traceparent')).toBe(c.traceparent);
    expect(JSON.parse(String(seen!.form.get('config')))).toEqual({ system: 'S', messages: [] });
    expect(p.pushed).toEqual([{ samples: 480, rate: 24_000 }, { samples: 240, rate: 24_000 }]);
    expect(events.map(e => e.type)).toEqual(['route', 'transcript', 'reply_delta', 'audio_start', 'reply', 'metrics', 'done', 'audio_end']);
    expect(events[0]).toEqual({ type: 'route', provider: 'composite', fallback: 'saturated' });
    expect(events[1]).toEqual({ type: 'transcript', text: 'um pão', final: true });
  });

  function streamOf(chunks: Uint8Array[], hold?: Promise<void>): typeof fetch {
    return (async () => new Response(new ReadableStream({
      async start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        await hold;
        c.close();
      },
    }), { status: 200 })) as unknown as typeof fetch;
  }

  it('an opener plays ahead of the reply: its audio first, audio_start only at the reply, one audio_end, the line reported', async () => {
    const events: RealtimeEvent[] = [];
    const p = fakePlayer();
    const t = createS2SStreamTransport(ctx(streamOf([
      encodeEvent({ type: 'audio_format', encoding: 'pcm_s16le', sample_rate: 24_000 }, 'binary'),
      encodeEvent({ type: 'opener', state: 'start', text: 'Hum.', index: 0, audio_ms: 20, at_ms: 1000 }, 'binary'),
      encodeAudio(new Uint8Array(960), 'binary'),
      encodeEvent({ type: 'opener', state: 'end', index: 0 }, 'binary'),
      encodeEvent({ type: 'transcript', text: 'um pão' }, 'binary'),
      encodeEvent({ type: 'audio_format', encoding: 'pcm_s16le', sample_rate: 24_000 }, 'binary'),
      encodeEvent({ type: 'first_audio', at_ms: 2400 }, 'binary'),
      encodeAudio(new Uint8Array(480), 'binary'),
      encodeEvent({ type: 'done', reply: 'Claro.', first_audio_ms: 2400, first_sound_ms: 1000, opener: 'Hum.', deadline_missed: false }, 'binary'),
    ]), events), { url: '/s' }, p.factory);
    await t.sendTurn!(new Blob(['x']));
    expect(p.pushed).toEqual([{ samples: 480, rate: 24_000 }, { samples: 240, rate: 24_000 }]);
    expect(events.map(e => e.type)).toEqual(['opener', 'opener', 'transcript', 'audio_start', 'reply', 'metrics', 'done', 'audio_end']);
    expect(events[0]).toEqual({ type: 'opener', state: 'start', text: 'Hum.', index: 0, audio_ms: 20 });
    expect(events.find(e => e.type === 'metrics')).toEqual({ type: 'metrics', ttfa_ms: 2400, first_sound_ms: 1000, opener: 'Hum.', deadline_missed: false });
  });

  it('an MP3 opener is decoded and queued when it ends, before the PCM reply; an opener with no reply still ends the audio', async () => {
    const order: string[] = [];
    const player: PcmPlayer = {
      pushPcm16: () => { order.push('pcm'); }, pushFloat: () => {}, flush: () => {}, playing: false, idle: async () => {},
      pushEncoded: async (data) => { order.push(`mp3:${new TextDecoder().decode(data)}`); }, close: () => {},
    };
    const opener = [
      encodeEvent({ type: 'audio_format', encoding: 'audio/mpeg' }, 'binary'), encodeEvent({ type: 'opener', state: 'start', text: 'Hum.', index: 0 }, 'binary'),
      encodeAudio(new TextEncoder().encode('ID3hum'), 'binary'), encodeEvent({ type: 'opener', state: 'end', index: 0 }, 'binary'),
    ];
    const events: RealtimeEvent[] = [];
    await createS2SStreamTransport(ctx(streamOf([
      ...opener, encodeEvent({ type: 'audio_format', encoding: 'pcm_s16le', sample_rate: 24_000 }, 'binary'), encodeAudio(new Uint8Array(480), 'binary'),
      encodeEvent({ type: 'done', reply: 'Claro.' }, 'binary'),
    ]), events), { url: '/s' }, async () => player).sendTurn!(new Blob(['x']));
    expect(order).toEqual(['mp3:ID3hum', 'pcm']);

    const alone: RealtimeEvent[] = [];
    await createS2SStreamTransport(ctx(streamOf([...opener, encodeEvent({ type: 'done', empty: true }, 'binary')]), alone), { url: '/s' }, async () => player).sendTurn!(new Blob(['x']));
    expect(alone.map(e => e.type)).toEqual(['opener', 'opener', 'metrics', 'done', 'audio_end']);
  });

  it('an MP3 sentence is played when its audio ends, not at the end of the turn', async () => {
    const order: string[] = [];
    const player: PcmPlayer = {
      pushPcm16: () => {}, pushFloat: () => {}, flush: () => {}, playing: false, idle: async () => {},
      pushEncoded: async (data) => { order.push(`mp3:${new TextDecoder().decode(data)}`); }, close: () => {},
    };
    const events: RealtimeEvent[] = [];
    const seen = ctx(streamOf([
      encodeEvent({ type: 'sentence', text: 'Um.' }, 'binary'), encodeEvent({ type: 'audio_format', encoding: 'audio/mpeg' }, 'binary'),
      encodeAudio(new TextEncoder().encode('ID3um'), 'binary'), encodeEvent({ type: 'sentence_end' }, 'binary'),
      encodeEvent({ type: 'sentence', text: 'Dois.' }, 'binary'), encodeAudio(new TextEncoder().encode('ID3dois'), 'binary'),
      encodeEvent({ type: 'sentence_end' }, 'binary'), encodeEvent({ type: 'done', reply: 'Um. Dois.' }, 'binary'),
    ]), events);
    const emit = seen.emit;
    seen.emit = (e: RealtimeEvent) => { if (e.type === 'reply_delta') order.push(`text:${e.text}`); emit(e); };
    await createS2SStreamTransport(seen, { url: '/s' }, async () => player).sendTurn!(new Blob(['x']));
    expect(order).toEqual(['text:Um.', 'mp3:ID3um', 'text:Dois.', 'mp3:ID3dois']);
  });

  it('interrupt during an opener: the player is flushed and the turn is cut like any audio', async () => {
    let flushed = 0;
    let release = () => {};
    const hold = new Promise<void>((r) => { release = r; });
    const player: PcmPlayer = {
      pushPcm16: () => {}, pushFloat: () => {}, flush: () => { flushed++; }, playing: true, idle: async () => {}, pushEncoded: async () => {}, close: () => {},
    };
    const events: RealtimeEvent[] = [];
    const t = createS2SStreamTransport(ctx(streamOf([
      encodeEvent({ type: 'opener', state: 'start', text: 'Hum.', index: 0 }, 'binary'), encodeAudio(new Uint8Array(960), 'binary'),
      encodeEvent({ type: 'opener', state: 'end', index: 0 }, 'binary'),
    ], hold), events), { url: '/s' }, async () => player);
    const turn = t.sendTurn!(new Blob(['x'])).catch(() => {});
    await new Promise(r => setTimeout(r, 20));
    t.send({ type: 'interrupt' });
    release();
    await turn;
    expect(flushed).toBe(1);
    expect(events.map(e => e.type)).toEqual(['opener', 'opener', 'interrupted', 'audio_end']);
  });

  it('a non-2xx answer rejects (the session fails over and re-sends the clip)', async () => {
    const t = createS2SStreamTransport(ctx((async () => new Response('{}', { status: 503 })) as unknown as typeof fetch, []), { url: '/s' }, fakePlayer().factory);
    await expect(t.sendTurn!(new Blob(['x']))).rejects.toThrow(/HTTP 503/);
  });

  const streamed = async (frames: Uint8Array[]) => {
    const fetchImpl = (async () => new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(f); c.close(); } }), { status: 200 })) as unknown as typeof fetch;
    const events: RealtimeEvent[] = [];
    await createS2SStreamTransport(ctx(fetchImpl, events), { url: '/s' }, fakePlayer().factory).sendTurn!(new Blob(['x']));
    return events;
  };
  const E = (e: Record<string, unknown> & { type: string }) => encodeEvent(e, 'binary');
  const A = encodeAudio(new Uint8Array(960), 'binary');

  it('regression: a stream that ends without done is a failed turn naming the sentence not voiced, never a silent end', async () => {
    const events = await streamed([E({ type: 'sentence', text: 'Bom dia!' }), A, E({ type: 'sentence', text: 'São dois reais.' })]);
    expect(events.slice(-3)).toEqual([
      { type: 'error', code: 'truncated', message: 's2s stream ended without done', unspoken: 'São dois reais.' }, { type: 'done', error: true }, { type: 'audio_end' },
    ]); // before: reply_delta, audio_end — no done, no error
    const heard = await streamed([E({ type: 'sentence', text: 'Bom dia!' }), A]);
    expect(heard.slice(-3, -1)).toEqual([{ type: 'error', code: 'truncated', message: 's2s stream ended without done' }, { type: 'done', error: true }]);
  });

  it('an in-band error ends the turn as failed, with or without a done after it, and carries the unspoken text', async () => {
    const error = E({ type: 'error', stage: 'tts', code: 'stage_failed', message: 'cut', unspoken: 'São dois reais.' });
    for (const tail of [[], [E({ type: 'done', partial: true, total_ms: 9 })]]) {
      const events = await streamed([E({ type: 'sentence', text: 'Bom dia!' }), A, error, ...tail]);
      expect(events.filter(e => e.type === 'error')).toEqual([{ type: 'error', code: 'tts', message: 'cut', unspoken: 'São dois reais.' }]);
      expect(events.filter(e => e.type === 'done')).toEqual([{ type: 'done', error: true }]);
    }
  });

  it('a done that reports sentences not voiced is a failed turn with those sentences to recover; a complete one is not', async () => {
    const events = await streamed([
      E({ type: 'sentence', text: 'Bom dia!' }), A, E({ type: 'sentence_failed', text: 'São dois reais.' }),
      E({ type: 'done', reply: 'Bom dia! São dois reais.', sentences: 2, spoken: 1, skipped: 1 }),
    ]);
    expect(events.filter(e => e.type === 'error')).toEqual([{ type: 'error', code: 'truncated', message: 'the reply ended with sentences not voiced', unspoken: 'São dois reais.' }]);
    expect(events.filter(e => e.type === 'done')).toEqual([{ type: 'done', error: true }]);
    const whole = await streamed([E({ type: 'sentence', text: 'Bom dia!' }), A, E({ type: 'done', reply: 'Bom dia!', sentences: 1, spoken: 1, skipped: 0 })]);
    expect(whole.filter(e => e.type === 'error' || e.type === 'done')).toEqual([{ type: 'done' }]);
  });

  it('maps filtered, error and empty done', () => {
    expect(mapS2SEvent({ type: 'filtered', reasons: ['blocklist'] })).toEqual([{ type: 'filtered', reasons: ['blocklist'] }]);
    expect(mapS2SEvent({ type: 'error', stage: 'llm', message: 'x' })).toEqual([{ type: 'error', code: 'llm', message: 'x' }]);
    expect(mapS2SEvent({ type: 'done', reply: '', empty: true, filtered: true, first_audio_ms: null }).map(e => e.type)).toEqual(['metrics', 'done']);
  });
});
