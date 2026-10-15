import { describe, expect, it } from 'vitest';
import { openrouterSTT } from '../../src/gateway/providers/cloud/openrouter';

function wav(seconds: number, rate = 16_000): Buffer {
  const data = Math.round(seconds * rate) * 2;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(data + 36, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data, 40);
  return Buffer.concat([head, Buffer.alloc(data)]);
}

function recordingOpenRouter() {
  const sent: Array<Record<string, unknown>> = [];
  const provider = openrouterSTT.withApiKey('fake');
  const create = async (params: Record<string, unknown>) => { sent.push(params); return { text: 'ok' }; };
  (provider as unknown as { client: unknown }).client = { audio: { transcriptions: { create } } };
  return { provider, sent };
}

describe('OpenRouter STT prompt', () => {
  it('goes in the options of every Whisper upstream, because OpenRouter drops a plain prompt', async () => {
    const { provider, sent } = recordingOpenRouter();
    await provider.transcribe({ audio: wav(1), model: 'openai/whisper-large-v3', prompt: 'Thalyrion, Zephyquant' });
    const prompt = { prompt: 'Thalyrion, Zephyquant' };
    expect(JSON.parse(sent[0].provider as string)).toEqual({ options: { deepinfra: prompt, groq: prompt, together: prompt } });
    expect(sent[0].prompt).toBe('Thalyrion, Zephyquant');
  });

  it('sends no provider options without a prompt', async () => {
    const { provider, sent } = recordingOpenRouter();
    await provider.transcribe({ audio: wav(1), model: 'elevenlabs/scribe-v2' });
    expect(sent[0].provider).toBeUndefined();
    expect(sent[0].model).toBe('elevenlabs/scribe-v2');
  });
});
