import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import type { TTSProvider } from '../../../src/gateway/providers/cloud/types';

let server: Server;

function ttsServer(cut: boolean): Promise<string> {
  let sent = 0;
  const provider = {
    providerId: 'self-hosted', isConfigured: () => true, getModels: () => [], getVoices: () => [],
    synthesize: async () => ({
      audio: Buffer.alloc(0), contentType: 'audio/pcm',
      stream: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent++ < 2) return controller.enqueue(new Uint8Array(4800));
          await new Promise((resolve) => setTimeout(resolve, 50));
          return cut ? controller.error(new TypeError('terminated')) : controller.close();
        },
      }),
    }),
  } as unknown as TTSProvider;
  server = createProxyServer({ providers: { tts: { 'parle-tts': provider } } as never });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function speech(base: string): Promise<{ bytes: number; error: unknown }> {
  const res = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'parle-tts', input: 'oi', voice: 'x', response_format: 'pcm' }),
  });
  expect(res.status).toBe(200);
  let bytes = 0;
  try {
    for await (const chunk of res.body!) bytes += chunk.length;
  } catch (error) {
    return { bytes, error };
  }
  return { bytes, error: null };
}

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('a streamed body that breaks upstream', () => {
  it('reaches the client as a cut connection, not as a complete answer', async () => {
    const { bytes, error } = await speech(await ttsServer(true));
    expect(bytes).toBe(9600);
    expect(error).toBeInstanceOf(Error);
  });

  it('a body that ends upstream is still a clean end', async () => {
    expect(await speech(await ttsServer(false))).toEqual({ bytes: 9600, error: null });
  });
});
