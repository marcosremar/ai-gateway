import { afterEach, describe, expect, it, vi } from 'vitest';
import { withProviderFallback } from '../../src/gateway/providers/cloud/fallback';
import { FalImageProvider } from '../../src/gateway/providers/cloud/fal/fal-image';

/* Alertas do CodeQL na PR #35 (06/10/2026): nome de modelo vindo do pedido em log e em URL. */
describe('model names from the request cannot forge log lines', () => {
  it('a model name with line breaks is logged on one line', async () => {
    const lines: string[] = [];
    const logger = { log: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } as never;
    const chain = [{ provider: 'p', model: 'm\n[admin] forged entry' }] as never;
    await expect(withProviderFallback(chain, async () => { throw Object.assign(new Error('boom'), { status: 500 }); },
      { logger, logPrefix: '[t]' })).rejects.toThrow();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/[\r\n]/);
  });
});

describe('fal model id is validated before it becomes a URL', () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.FAL_KEY; });

  it('refuses a model that is not an app id, without calling anyone', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.FAL_KEY = 'unit-test-fal-key';
    const fal = new FalImageProvider();
    for (const model of ['@evil.example/x', '../../admin', 'fal-ai/flux schnell', 'x']) {
      await expect(fal.generate({ prompt: 'p', model } as never)).rejects.toThrow(/invalid fal model id/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
