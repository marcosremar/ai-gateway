import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  falGenerate: vi.fn(async (req: { model?: string }) => ({ model: req.model })),
  dit360Generate: vi.fn(async () => ({ provider: 'dit360' })),
  falConfigured: true,
  dit360Configured: true,
}));
const { falGenerate, dit360Generate } = h;

vi.mock('../../src/modules/gateway/providers/cloud/fal/fal-image', () => ({
  FalImageProvider: class {
    isConfigured() { return h.falConfigured; }
    generate = h.falGenerate;
  },
}));

vi.mock('../../src/modules/gateway/providers/cloud/dit360/dit360-image', () => ({
  Dit360ImageProvider: class {
    isConfigured() { return h.dit360Configured; }
    generate = h.dit360Generate;
  },
}));

import { RoutingImageProvider } from '../../src/modules/gateway/providers/cloud/routing-image';

describe('RoutingImageProvider.generate routing', () => {
  let provider: RoutingImageProvider;

  beforeEach(() => {
    falGenerate.mockClear();
    dit360Generate.mockClear();
    h.falConfigured = true;
    h.dit360Configured = true;
    provider = new RoutingImageProvider();
  });

  it('routes dit360 to the DiT360 provider', async () => {
    await provider.generate({ prompt: 'p', model: 'dit360' });
    expect(dit360Generate).toHaveBeenCalledOnce();
    expect(falGenerate).not.toHaveBeenCalled();
  });

  it('maps bare flux aliases to fal.run model paths', async () => {
    for (const [alias, mapped] of [
      ['flux-schnell', 'fal-ai/flux/schnell'],
      ['flux', 'fal-ai/flux/schnell'],
      ['flux-pro', 'fal-ai/flux-pro/v1/fill'],
      ['flux-fill', 'fal-ai/flux-pro/v1/fill'],
      ['flux-dev', 'fal-ai/flux/dev'],
    ]) {
      falGenerate.mockClear();
      await provider.generate({ prompt: 'p', model: alias });
      expect(falGenerate).toHaveBeenCalledWith(expect.objectContaining({ model: mapped }));
    }
  });

  it('passes native fal-ai/* paths through verbatim', async () => {
    await provider.generate({ prompt: 'p', model: 'fal-ai/recraft/v3' });
    expect(falGenerate).toHaveBeenCalledWith(expect.objectContaining({ model: 'fal-ai/recraft/v3' }));
  });

  it('drops empty model so fal uses its own default', async () => {
    await provider.generate({ prompt: 'p', model: '   ' });
    expect(falGenerate).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it('throws a 400 for an unknown model', async () => {
    await expect(provider.generate({ prompt: 'p', model: 'midjourney' }))
      .rejects.toMatchObject({ status: 400 });
    expect(falGenerate).not.toHaveBeenCalled();
  });

  it('isConfigured is true when either backend is configured', () => {
    h.falConfigured = false;
    h.dit360Configured = true;
    expect(new RoutingImageProvider().isConfigured()).toBe(true);
    h.falConfigured = false;
    h.dit360Configured = false;
    expect(new RoutingImageProvider().isConfigured()).toBe(false);
  });
});
