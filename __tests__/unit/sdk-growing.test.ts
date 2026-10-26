import { describe, expect, it } from 'vitest';
import { GatewayClient } from '../../sdk/node/gateway-client';
import { GrowingUtterance, wavPcm16 } from '../../sdk/node/growing-utterance';

describe('GrowingUtterance', () => {
  it('uploads only the new audio and joins the line', () => {
    const u = new GrowingUtterance();
    expect(u.piece(4 * 16_000)).toEqual({ start: 0, continued: false });
    expect(u.accept(false, 'a reunião começa agora', 4 * 16_000)).toBe('a reunião começa agora');
    expect(u.piece(6 * 16_000)).toEqual({ start: 2 * 16_000, continued: true });
    expect(u.accept(true, 'começa agora e o orçamento', 6 * 16_000)).toBe('a reunião começa agora e o orçamento');
    expect(u.piece(6 * 16_000)).toBeNull();
    expect(u.accept(true, 'o tempo fechou de vez', 8 * 16_000)).toBeNull();
    expect(u.piece(8 * 16_000)?.start).toBe(0);
    expect(wavPcm16([0, 1, -1]).length).toBe(44 + 6);
  });

  it('posts only the new piece', async () => {
    const sizes: number[] = [];
    const texts = ['a reunião começa agora', 'começa agora e o orçamento'];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const file = (init?.body as FormData).get('file') as Blob;
      sizes.push(file.size);
      return new Response(JSON.stringify({ text: texts[sizes.length - 1] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const gw = new GatewayClient({ baseUrl: 'http://gw.test', apiKey: 'k', fetch: fetchImpl });
    const u = new GrowingUtterance();
    const pcm = new Int16Array(6 * 16_000);
    expect(await gw.transcribeGrowing(u, pcm.subarray(0, 4 * 16_000), { model: 'babelcast-stt' })).toBe(texts[0]);
    expect(await gw.transcribeGrowing(u, pcm, { model: 'babelcast-stt' })).toBe('a reunião começa agora e o orçamento');
    expect(sizes[0]).toBe(44 + 4 * 16_000 * 2);
    expect(sizes[1]).toBe(44 + 4 * 16_000 * 2);
    expect(await gw.transcribeGrowing(u, pcm, { model: 'babelcast-stt' })).toBeNull();
    expect(sizes.length).toBe(2);
  });
});
