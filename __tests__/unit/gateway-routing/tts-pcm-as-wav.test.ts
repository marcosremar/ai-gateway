import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { OpenAICompatTTSProvider } from '../../../src/gateway/providers/cloud/openai-compat/openai-compat-tts';
import { WavStripper } from '../../../src/s2s/composite';

let server: Server | null = null;
afterEach(async () => { server?.closeAllConnections(); await new Promise(r => server?.close(r)); server = null; });

async function provider() {
  const asked: Array<Record<string, unknown>> = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body) as Record<string, unknown>;
      asked.push(json);
      res.writeHead(200, { 'Content-Type': json.response_format === 'pcm' ? 'audio/pcm;rate=22050;channels=1' : 'audio/mpeg' });
      res.write(Buffer.from([1, 2, 3, 4]));
      setTimeout(() => res.end(Buffer.from([5, 6])), 80);
    });
  });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  const tts = new OpenAICompatTTSProvider({
    providerId: 'openrouter', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, envKey: 'UNUSED_KEY', models: [], voices: [],
    defaultFormat: 'mp3', allowedFormats: ['mp3', 'pcm'], passthroughVoices: true, pcmAsWavRate: 24_000,
  }).withApiKey('k');
  return { tts, asked };
}

describe('OpenAI-compatible TTS: a WAV asked from a provider that only has PCM', () => {
  it('streams the PCM behind a WAV header as it arrives, at the rate the provider names', async () => {
    const { tts, asked } = await provider();
    const t0 = performance.now();
    const out = await tts.synthesize({ model: 'm', input: 'oi', voice: 'v', responseFormat: 'wav', stream: true });
    expect(out.contentType).toBe('audio/wav');
    expect(asked[0].response_format).toBe('pcm');
    const stripper = new WavStripper();
    const reader = out.stream!.getReader();
    const pcm: number[] = [];
    let firstAt = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const data = stripper.push(value);
      if (data.length && !firstAt) firstAt = performance.now() - t0;
      pcm.push(...data);
    }
    expect(pcm).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stripper.sampleRate).toBe(22_050);
    expect(firstAt).toBeLessThan(70);
  });

  it('without stream answers one WAV with its real size; other formats are untouched', async () => {
    const { tts, asked } = await provider();
    const whole = await tts.synthesize({ model: 'm', input: 'oi', voice: 'v', responseFormat: 'wav' });
    expect(whole.audio.length).toBe(50);
    expect(whole.audio.readUInt32LE(40)).toBe(6);
    expect(whole.audio.readUInt32LE(24)).toBe(22_050);
    const mp3 = await tts.synthesize({ model: 'm', input: 'oi', voice: 'v', responseFormat: 'mp3', stream: true });
    expect(mp3.contentType).toBe('audio/mpeg');
    expect(mp3.stream).toBeUndefined();
    expect(asked.map(a => a.response_format)).toEqual(['pcm', 'mp3']);
  });
});
