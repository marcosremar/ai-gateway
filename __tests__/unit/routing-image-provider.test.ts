/**
 * Unit tests for src/gateway/providers/cloud/routing-image.ts
 *
 * Covers: model-based routing to Dit360/Fal providers, FAL alias mapping,
 * fal-ai/* passthrough, empty-model fallback, unknown-model 400 error,
 * and isConfigured() delegation.
 *
 * Both inner providers are fully mocked — no network I/O.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { falState, dit360State } = vi.hoisted(() => {
  const falState = {
    configured: true,
    capturedRequest: null as unknown,
    response: { url: 'https://fal.cdn/out.png', width: 512, height: 512, revisedPrompt: undefined },
  };
  const dit360State = {
    configured: false,
    capturedRequest: null as unknown,
    response: { url: 'https://dit360.local/out.png', width: 2048, height: 1024, revisedPrompt: undefined },
  };
  return { falState, dit360State };
});

vi.mock('../../src/gateway/providers/cloud/fal/fal-image', () => {
  function FalImageProvider(this: unknown) {}
  FalImageProvider.prototype.isConfigured = function () { return falState.configured; };
  FalImageProvider.prototype.generate = async function (req: unknown) {
    falState.capturedRequest = req;
    return falState.response;
  };
  return { FalImageProvider };
});

vi.mock('../../src/gateway/providers/cloud/dit360/dit360-image', () => {
  function Dit360ImageProvider(this: unknown) {}
  Dit360ImageProvider.prototype.isConfigured = function () { return dit360State.configured; };
  Dit360ImageProvider.prototype.generate = async function (req: unknown) {
    dit360State.capturedRequest = req;
    return dit360State.response;
  };
  return { Dit360ImageProvider };
});

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  defaultLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { RoutingImageProvider } from '../../src/gateway/providers/cloud/routing-image';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(model?: string, extra?: Record<string, unknown>) {
  return { prompt: 'a photo of a cat', model, ...extra };
}

function resetState() {
  falState.configured = true;
  falState.capturedRequest = null;
  dit360State.configured = false;
  dit360State.capturedRequest = null;
}

// ── isConfigured ──────────────────────────────────────────────────────────────

describe('RoutingImageProvider.isConfigured()', () => {
  beforeEach(resetState);

  it('returns true when fal is configured', () => {
    falState.configured = true;
    dit360State.configured = false;
    const router = new RoutingImageProvider();
    expect(router.isConfigured()).toBe(true);
  });

  it('returns true when dit360 is configured', () => {
    falState.configured = false;
    dit360State.configured = true;
    const router = new RoutingImageProvider();
    expect(router.isConfigured()).toBe(true);
  });

  it('returns true when both are configured', () => {
    falState.configured = true;
    dit360State.configured = true;
    const router = new RoutingImageProvider();
    expect(router.isConfigured()).toBe(true);
  });

  it('returns false when neither is configured', () => {
    falState.configured = false;
    dit360State.configured = false;
    const router = new RoutingImageProvider();
    expect(router.isConfigured()).toBe(false);
  });
});

// ── Dit360 routing ────────────────────────────────────────────────────────────

describe('RoutingImageProvider.generate() — dit360 routing', () => {
  beforeEach(resetState);

  it('routes model="dit360" to Dit360ImageProvider', async () => {
    const router = new RoutingImageProvider();
    const req = makeRequest('dit360');
    const resp = await router.generate(req);
    expect(resp).toBe(dit360State.response);
    expect(dit360State.capturedRequest).toEqual(req);
    expect(falState.capturedRequest).toBeNull();
  });

  it('passes the original request unmodified to Dit360', async () => {
    const router = new RoutingImageProvider();
    const req = makeRequest('dit360', { width: 2048, height: 1024 });
    await router.generate(req);
    expect((dit360State.capturedRequest as Record<string, unknown>).width).toBe(2048);
    expect((dit360State.capturedRequest as Record<string, unknown>).prompt).toBe('a photo of a cat');
  });
});

// ── FAL alias routing ─────────────────────────────────────────────────────────

describe('RoutingImageProvider.generate() — FAL alias routing', () => {
  beforeEach(resetState);

  it('maps "flux-schnell" → "fal-ai/flux/schnell"', async () => {
    const router = new RoutingImageProvider();
    await router.generate(makeRequest('flux-schnell'));
    const sentReq = falState.capturedRequest as Record<string, unknown>;
    expect(sentReq.model).toBe('fal-ai/flux/schnell');
  });

  it('maps "flux" → "fal-ai/flux/schnell"', async () => {
    const router = new RoutingImageProvider();
    await router.generate(makeRequest('flux'));
    expect((falState.capturedRequest as Record<string, unknown>).model).toBe('fal-ai/flux/schnell');
  });

  it('maps "flux-pro" → "fal-ai/flux-pro/v1/fill"', async () => {
    const router = new RoutingImageProvider();
    await router.generate(makeRequest('flux-pro'));
    expect((falState.capturedRequest as Record<string, unknown>).model).toBe('fal-ai/flux-pro/v1/fill');
  });

  it('maps "flux-fill" → "fal-ai/flux-pro/v1/fill"', async () => {
    const router = new RoutingImageProvider();
    await router.generate(makeRequest('flux-fill'));
    expect((falState.capturedRequest as Record<string, unknown>).model).toBe('fal-ai/flux-pro/v1/fill');
  });

  it('maps "flux-dev" → "fal-ai/flux/dev"', async () => {
    const router = new RoutingImageProvider();
    await router.generate(makeRequest('flux-dev'));
    expect((falState.capturedRequest as Record<string, unknown>).model).toBe('fal-ai/flux/dev');
  });

  it('preserves all other request fields when mapping aliases', async () => {
    const router = new RoutingImageProvider();
    await router.generate({ prompt: 'sunset', model: 'flux-schnell', width: 1024 });
    const sent = falState.capturedRequest as Record<string, unknown>;
    expect(sent.prompt).toBe('sunset');
    expect(sent.width).toBe(1024);
  });

  it('does not route aliased models to dit360', async () => {
    const router = new RoutingImageProvider();
    await router.generate(makeRequest('flux-schnell'));
    expect(dit360State.capturedRequest).toBeNull();
  });
});

// ── fal-ai/* passthrough ──────────────────────────────────────────────────────

describe('RoutingImageProvider.generate() — fal-ai/* passthrough', () => {
  beforeEach(resetState);

  it('passes "fal-ai/flux/dev" through verbatim', async () => {
    const router = new RoutingImageProvider();
    const req = makeRequest('fal-ai/flux/dev');
    await router.generate(req);
    expect(falState.capturedRequest).toBe(req); // same object reference
    expect((falState.capturedRequest as Record<string, unknown>).model).toBe('fal-ai/flux/dev');
  });

  it('passes "fal-ai/stable-diffusion-xl" through verbatim', async () => {
    const router = new RoutingImageProvider();
    await router.generate(makeRequest('fal-ai/stable-diffusion-xl'));
    expect((falState.capturedRequest as Record<string, unknown>).model).toBe('fal-ai/stable-diffusion-xl');
  });

  it('passes "fal-ai/some/custom/path" through verbatim', async () => {
    const router = new RoutingImageProvider();
    await router.generate(makeRequest('fal-ai/some/custom/path'));
    expect((falState.capturedRequest as Record<string, unknown>).model).toBe('fal-ai/some/custom/path');
  });

  it('does not rewrite fal-ai/* models', async () => {
    const router = new RoutingImageProvider();
    const model = 'fal-ai/flux/schnell';
    await router.generate(makeRequest(model));
    // Should be passed verbatim, not re-mapped
    expect((falState.capturedRequest as Record<string, unknown>).model).toBe(model);
  });
});

// ── Empty / undefined model ───────────────────────────────────────────────────

describe('RoutingImageProvider.generate() — empty model', () => {
  beforeEach(resetState);

  it('routes empty string model to fal with model=undefined', async () => {
    const router = new RoutingImageProvider();
    await router.generate(makeRequest(''));
    expect(falState.capturedRequest).not.toBeNull();
    expect((falState.capturedRequest as Record<string, unknown>).model).toBeUndefined();
  });

  it('strips original empty-string model from request sent to fal', async () => {
    const router = new RoutingImageProvider();
    await router.generate({ prompt: 'test', model: '' });
    const sent = falState.capturedRequest as Record<string, unknown>;
    expect(sent.model).toBeUndefined();
    expect(sent.prompt).toBe('test');
  });

  it('does not route empty-model to dit360', async () => {
    const router = new RoutingImageProvider();
    await router.generate(makeRequest(''));
    expect(dit360State.capturedRequest).toBeNull();
  });
});

// ── Unknown model → 400 error ─────────────────────────────────────────────────

describe('RoutingImageProvider.generate() — unknown model throws 400', () => {
  beforeEach(resetState);

  it('throws for an unknown model name', async () => {
    const router = new RoutingImageProvider();
    await expect(router.generate(makeRequest('unknown-model'))).rejects.toThrow(/Unknown image model/);
  });

  it('thrown error has status 400', async () => {
    const router = new RoutingImageProvider();
    let err: unknown;
    try {
      await router.generate(makeRequest('not-a-model'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: number }).status).toBe(400);
  });

  it('error message includes the bad model name', async () => {
    const router = new RoutingImageProvider();
    await expect(router.generate(makeRequest('my-bad-model'))).rejects.toThrow('my-bad-model');
  });

  it('error message lists known models', async () => {
    const router = new RoutingImageProvider();
    await expect(router.generate(makeRequest('bad'))).rejects.toThrow(/dit360|flux|fal-ai/);
  });

  it('does not call fal or dit360 on unknown model', async () => {
    const router = new RoutingImageProvider();
    try { await router.generate(makeRequest('bogus')); } catch { /* expected */ }
    expect(falState.capturedRequest).toBeNull();
    expect(dit360State.capturedRequest).toBeNull();
  });

  it('"dall-e-3" is not a recognized model (routes via unknown → 400)', async () => {
    // "dall-e-3" is mentioned in the module docstring as "currently routed through fal"
    // but is NOT in FAL_MODEL_ALIASES or the fal-ai/* prefix. This test pins the
    // ACTUAL behaviour (throws 400) until the route is wired.
    const router = new RoutingImageProvider();
    await expect(router.generate(makeRequest('dall-e-3'))).rejects.toMatchObject({ status: 400 });
  });
});

// ── Response passthrough ──────────────────────────────────────────────────────

describe('RoutingImageProvider.generate() — response passthrough', () => {
  beforeEach(resetState);

  it('returns the fal response for fal-routed models', async () => {
    const router = new RoutingImageProvider();
    const resp = await router.generate(makeRequest('flux-schnell'));
    expect(resp).toBe(falState.response);
  });

  it('returns the dit360 response for dit360 model', async () => {
    const router = new RoutingImageProvider();
    const resp = await router.generate(makeRequest('dit360'));
    expect(resp).toBe(dit360State.response);
  });
});

// ── providerId ────────────────────────────────────────────────────────────────

describe('RoutingImageProvider.providerId', () => {
  it('has providerId "self-hosted"', () => {
    const router = new RoutingImageProvider();
    expect(router.providerId).toBe('self-hosted');
  });
});
