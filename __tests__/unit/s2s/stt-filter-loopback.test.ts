import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetSttCache, handleAudioTranscriptions } from '../../../src/gateway/proxy/routes/audio-transcriptions';
import { runComposite, type S2SConfig } from '../../../src/s2s/composite';
import { loopbackStages } from '../../../src/s2s/loopback-stages';
import type { S2SEvent } from '../../../src/s2s/frames';

/** Composed s2s path: loopbackStages → (HTTP in prod, direct call here) → the gateway's own /v1/audio/transcriptions. */
function wire(text: string) {
  const sttProvider = { providerId: 'fake', transcribe: vi.fn(async () => ({ text })), getModels: () => [], isConfigured: () => true };
  const seen: Array<{ language?: unknown; filter?: unknown }> = [];
  const fetchImpl = (async (url: string, init: { body: FormData }) => {
    if (!String(url).endsWith('/v1/audio/transcriptions')) throw new Error(`unexpected stage call ${url}`);
    const f = init.body;
    seen.push({ language: f.get('language'), filter: f.get('filter_hallucinations') });
    const out = await handleAudioTranscriptions({
      method: 'POST', url: '/v1/audio/transcriptions', headers: {}, rawBody: Buffer.from([1, 2, 3]),
      body: Object.fromEntries([...f.entries()].filter(([, v]) => typeof v === 'string')),
    }, { 'stt-m': sttProvider } as never);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: out.headers });
  }) as unknown as typeof fetch;
  return { stages: loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { stt: 'stt-m' } }), seen };
}

async function run(text: string, config: S2SConfig) {
  const { stages, seen } = wire(text);
  const events: S2SEvent[] = [];
  const chat = vi.spyOn(stages, 'chatStream');
  const result = await runComposite({ stages, audio: new Uint8Array([1]), contentType: 'audio/wav', config, signal: new AbortController().signal,
    emitEvent: e => events.push(e), emitAudio: () => {} }).catch(() => null); // chat/tts stages are not wired here
  return { events, seen, chat, result };
}

beforeEach(() => _resetSttCache());

describe('s2s composed path inherits the STT filter through the loopback route', () => {
  it('a hallucinated transcript: language reaches the route, transcript empty, `filtered` event, done, no LLM call', async () => {
    const { events, seen, chat } = await run('E aí.', { language: 'pt' });
    expect(seen[0].language).toBe('pt');
    expect(events.map(e => e.type)).toEqual(['transcript', 'filtered', 'done']);
    expect(events[0]).toMatchObject({ text: '' });
    expect(events[1]).toMatchObject({ stage: 'stt', reasons: ['blocklist'] });
    expect(events[2]).toMatchObject({ empty: true });
    expect(chat).not.toHaveBeenCalled();
  });

  it('config.filter_hallucinations=false is forwarded as the multipart field', async () => {
    const { seen, events } = await run('E aí.', { language: 'pt', filter_hallucinations: false });
    expect(seen[0].filter).toBe('false');
    expect(events[0]).toMatchObject({ text: 'E aí.' });
  });
});
