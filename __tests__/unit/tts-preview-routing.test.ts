// ── TTS Preview Routing ───────────────────────────────────────────────────────
// Unit tests for generateTtsPreview engine selection, speaker parsing, and
// fallback chain behaviour. All external I/O is mocked — no real network calls.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock validateRemoteEndpointResolved so SSRF checks are no-ops in tests.
vi.mock('../../src/gateway/pipeline/ssrf-protection', () => ({
  validateRemoteEndpointResolved: vi.fn().mockResolvedValue(undefined),
  validateEndpointUrl: vi.fn(),
  validateRemoteEndpoint: vi.fn(),
}));

import type {
  TtsPreviewInput,
  TtsPreviewDeps,
  TtsPreviewResult,
} from '../../src/gateway/pipeline/tts-preview';
import { generateTtsPreview } from '../../src/gateway/pipeline/tts-preview';

// ── Shared test data ──────────────────────────────────────────────────────────

const GPU_AUDIO = Buffer.from('gpu-audio');
const KOKORO_AUDIO = Buffer.from('kokoro-audio');
const MODAL_AUDIO = Buffer.from('modal-audio');
const CLOUD_AUDIO = Buffer.from('cloud-audio');
const MINIMAX_AUDIO = Buffer.from('minimax-audio');

function makeInput(overrides: Partial<TtsPreviewInput> = {}): TtsPreviewInput {
  return {
    text: 'Hello world',
    speaker: 'Ryan',
    language: 'en',
    referenceAudio: '',
    refText: '',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TtsPreviewDeps> = {}): TtsPreviewDeps {
  return {
    gpuEndpoint: null,
    localKokoroUrl: null,
    client: {
      synthesize: vi.fn().mockResolvedValue({
        audio: CLOUD_AUDIO,
        contentType: 'audio/wav',
      }),
    },
    modalTTS: {
      synthesize: vi.fn().mockResolvedValue({
        audio: MODAL_AUDIO,
        contentType: 'audio/wav',
      }),
    },
    translationProfile: {} as TtsPreviewDeps['translationProfile'],
    ...overrides,
  };
}

// ── Fetch mock helpers ────────────────────────────────────────────────────────

function mockFetchOk(audio: Buffer, contentType = 'audio/wav') {
  return vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)),
    text: () => Promise.resolve(''),
  });
}

function mockFetchFail(status = 500, body = 'error') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    text: () => Promise.resolve(body),
  });
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('generateTtsPreview — GPU path', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns GPU result when GPU endpoint is set and healthy', async () => {
    vi.stubGlobal('fetch', mockFetchOk(GPU_AUDIO));
    const deps = makeDeps({ gpuEndpoint: 'http://gpu.example.com' });
    const result: TtsPreviewResult = await generateTtsPreview(makeInput(), deps);
    expect(result.source).toBe('gpu');
    expect(result.audio).toEqual(GPU_AUDIO);
  });

  it('falls through to cloud when GPU returns non-ok status', async () => {
    vi.stubGlobal('fetch', mockFetchFail(503));
    const deps = makeDeps({ gpuEndpoint: 'http://gpu.example.com' });
    const result = await generateTtsPreview(makeInput(), deps);
    expect(result.source).toBe('cloud');
  });

  it('skips GPU for kokoro engine, uses local Kokoro instead', async () => {
    vi.stubGlobal('fetch', mockFetchOk(KOKORO_AUDIO));
    const deps = makeDeps({
      gpuEndpoint: 'http://gpu.example.com',
      localKokoroUrl: 'http://kokoro.local',
    });
    const result = await generateTtsPreview(makeInput({ speaker: 'kokoro/af_sarah' }), deps);
    // engine=kokoro → GPU skipped; local Kokoro used instead
    expect(result.source).toBe('local-kokoro');
  });

  it('throws when kokoro engine is forced but no local Kokoro is available', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const deps = makeDeps({ gpuEndpoint: 'http://gpu.example.com' }); // localKokoroUrl=null
    await expect(
      generateTtsPreview(makeInput({ speaker: 'kokoro/af_sarah' }), deps),
    ).rejects.toThrow("engine='kokoro' requested but no matching backend succeeded");
    expect(mockFetch).not.toHaveBeenCalled(); // GPU not tried for kokoro engine
  });

  it('uses GPU when engine is qwen3', async () => {
    vi.stubGlobal('fetch', mockFetchOk(GPU_AUDIO));
    const deps = makeDeps({ gpuEndpoint: 'http://gpu.example.com' });
    const result = await generateTtsPreview(makeInput({ speaker: 'qwen3/serena' }), deps);
    expect(result.source).toBe('gpu');
  });

  it('uses GPU when engine is qwen (alias for qwen3)', async () => {
    vi.stubGlobal('fetch', mockFetchOk(GPU_AUDIO));
    const deps = makeDeps({ gpuEndpoint: 'http://gpu.example.com' });
    const result = await generateTtsPreview(makeInput({ speaker: 'qwen/serena' }), deps);
    expect(result.source).toBe('gpu');
  });

  it('skips GPU for cloud engine', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const deps = makeDeps({ gpuEndpoint: 'http://gpu.example.com' });
    const result = await generateTtsPreview(makeInput({ speaker: 'cloud/Ryan' }), deps);
    expect(result.source).toBe('cloud');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('generateTtsPreview — Local Kokoro path', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses local Kokoro when set and GPU is absent', async () => {
    vi.stubGlobal('fetch', mockFetchOk(KOKORO_AUDIO));
    const deps = makeDeps({ localKokoroUrl: 'http://kokoro.local:8880' });
    const result = await generateTtsPreview(makeInput({ speaker: 'af_sarah' }), deps);
    expect(result.source).toBe('local-kokoro');
    expect(result.audio).toEqual(KOKORO_AUDIO);
  });

  it('sends POST to /v1/audio/speech on kokoro URL', async () => {
    const mockFetch = mockFetchOk(KOKORO_AUDIO);
    vi.stubGlobal('fetch', mockFetch);
    const deps = makeDeps({ localKokoroUrl: 'http://kokoro.local:8880' });
    await generateTtsPreview(makeInput({ speaker: 'af_sarah', text: 'Test' }), deps);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://kokoro.local:8880/v1/audio/speech',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('skips local Kokoro for clone requests (uses Modal instead)', async () => {
    const mockFetch = vi.fn(); // should not be called
    vi.stubGlobal('fetch', mockFetch);
    const deps = makeDeps({ localKokoroUrl: 'http://kokoro.local:8880' });
    const modalSynth = vi.fn().mockResolvedValue({ audio: MODAL_AUDIO, contentType: 'audio/wav' });
    deps.modalTTS.synthesize = modalSynth;
    // Use auto-engine voice (not kokoro-style) so Modal is reachable
    const result = await generateTtsPreview(makeInput({
      speaker: 'Ryan',
      referenceAudio: 'base64data',
      refText: 'Reference',
    }), deps);
    // Local Kokoro skipped for clone; Modal used
    expect(mockFetch).not.toHaveBeenCalled();
    expect(modalSynth).toHaveBeenCalled();
    expect(result.source).toBe('modal-clone');
  });

  it('falls through to cloud when local Kokoro returns non-ok (auto engine)', async () => {
    vi.stubGlobal('fetch', mockFetchFail(500));
    // Use auto-engine speaker so cloud fallback is allowed
    const deps = makeDeps({ localKokoroUrl: 'http://kokoro.local:8880' });
    const result = await generateTtsPreview(makeInput({ speaker: 'Ryan' }), deps);
    expect(result.source).toBe('cloud');
  });

  it('throws when kokoro engine is forced and local Kokoro returns non-ok', async () => {
    vi.stubGlobal('fetch', mockFetchFail(500));
    const deps = makeDeps({ localKokoroUrl: 'http://kokoro.local:8880' });
    // engine=kokoro: allowCloud=false → throws after Kokoro fails
    await expect(
      generateTtsPreview(makeInput({ speaker: 'af_sarah' }), deps),
    ).rejects.toThrow("engine='kokoro' requested but no matching backend succeeded");
  });

  it('falls through to cloud when local Kokoro throws (network error, auto engine)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const deps = makeDeps({ localKokoroUrl: 'http://kokoro.local:8880' });
    const result = await generateTtsPreview(makeInput({ speaker: 'Ryan' }), deps);
    expect(result.source).toBe('cloud');
  });
});

describe('generateTtsPreview — Modal clone path', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses Modal for clone requests with no GPU', async () => {
    const deps = makeDeps();
    const result = await generateTtsPreview(makeInput({
      referenceAudio: 'data:audio/wav;base64,abc',
      refText: 'Hello',
    }), deps);
    expect(result.source).toBe('modal-clone');
    expect(result.audio).toEqual(MODAL_AUDIO);
    expect(deps.modalTTS.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceAudio: 'data:audio/wav;base64,abc',
        refText: 'Hello',
      }),
    );
  });

  it('passes model=qwen3-tts to Modal', async () => {
    const deps = makeDeps();
    await generateTtsPreview(makeInput({
      referenceAudio: 'ref',
      refText: 'Text',
    }), deps);
    expect(deps.modalTTS.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'qwen3-tts' }),
    );
  });

  it('skips Modal when engine=kokoro (clone with explicit kokoro engine goes to error)', async () => {
    const deps = makeDeps();
    await expect(
      generateTtsPreview(makeInput({
        speaker: 'kokoro/af_sarah',
        referenceAudio: 'ref',
        refText: 'Text',
      }), deps),
    ).rejects.toThrow("engine='kokoro' requested but no matching backend succeeded");
    expect(deps.modalTTS.synthesize).not.toHaveBeenCalled();
  });

  it('throws when modal engine is requested for a non-clone request', async () => {
    const deps = makeDeps();
    // engine=modal + isCloneRequest=false → Modal step skipped; allowCloud=false → throws
    await expect(
      generateTtsPreview(makeInput({ speaker: 'modal/Ryan' }), deps),
    ).rejects.toThrow("engine='modal' requested but no matching backend succeeded");
  });
});

describe('generateTtsPreview — Minimax path', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes Portuguese_ voice to minimax engine', async () => {
    const minimaxSynth = vi.fn().mockResolvedValue({ audio: MINIMAX_AUDIO, contentType: 'audio/mpeg' });
    const deps = makeDeps({
      minimaxTTS: { synthesize: minimaxSynth },
    });
    const result = await generateTtsPreview(makeInput({ speaker: 'Portuguese_Woman' }), deps);
    expect(result.source).toBe('minimax');
    expect(minimaxSynth).toHaveBeenCalled();
  });

  it('routes English_ voice to minimax engine', async () => {
    const minimaxSynth = vi.fn().mockResolvedValue({ audio: MINIMAX_AUDIO, contentType: 'audio/mpeg' });
    const deps = makeDeps({ minimaxTTS: { synthesize: minimaxSynth } });
    const result = await generateTtsPreview(makeInput({ speaker: 'English_Trustworthy_Man' }), deps);
    expect(result.source).toBe('minimax');
  });

  it('throws when minimax engine requested but dep is missing', async () => {
    const deps = makeDeps({ minimaxTTS: undefined });
    await expect(
      generateTtsPreview(makeInput({ speaker: 'Portuguese_Woman' }), deps),
    ).rejects.toThrow("minimaxTTS dep is missing");
  });

  it('explicit minimax/ prefix routes to minimax', async () => {
    const minimaxSynth = vi.fn().mockResolvedValue({ audio: MINIMAX_AUDIO, contentType: 'audio/mpeg' });
    const deps = makeDeps({ minimaxTTS: { synthesize: minimaxSynth } });
    const result = await generateTtsPreview(makeInput({ speaker: 'minimax/English_Man' }), deps);
    expect(result.source).toBe('minimax');
  });
});

describe('generateTtsPreview — Cloud fallback', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses cloud when no GPU, no Kokoro, no clone, auto engine', async () => {
    const deps = makeDeps();
    const result = await generateTtsPreview(makeInput(), deps);
    expect(result.source).toBe('cloud');
    expect(result.audio).toEqual(CLOUD_AUDIO);
  });

  it('passes speaker as voice to cloud synthesize', async () => {
    const deps = makeDeps();
    await generateTtsPreview(makeInput({ speaker: 'Rachel' }), deps);
    expect(deps.client.synthesize).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ voice: 'Rachel' }),
    );
  });

  it('explicit cloud/ prefix routes directly to cloud', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const deps = makeDeps({ gpuEndpoint: 'http://gpu.example.com', localKokoroUrl: 'http://kokoro.local' });
    const result = await generateTtsPreview(makeInput({ speaker: 'cloud/Ryan' }), deps);
    expect(result.source).toBe('cloud');
    expect(mockFetch).not.toHaveBeenCalled(); // GPU and Kokoro skipped
  });

  it('throws when only GPU engine and GPU unavailable', async () => {
    const deps = makeDeps();
    await expect(
      generateTtsPreview(makeInput({ speaker: 'gpu/serena' }), deps),
    ).rejects.toThrow("engine='gpu' requested but no matching backend succeeded");
  });
});

describe('generateTtsPreview — speaker parsing via routing', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('bare voice "Ryan" routes to auto (cloud)', async () => {
    const deps = makeDeps();
    const result = await generateTtsPreview(makeInput({ speaker: 'Ryan' }), deps);
    expect(result.source).toBe('cloud');
  });

  it('kokoro-style voice "af_sarah" routes to auto kokoro', async () => {
    vi.stubGlobal('fetch', mockFetchOk(KOKORO_AUDIO));
    const deps = makeDeps({ localKokoroUrl: 'http://kokoro.local' });
    const result = await generateTtsPreview(makeInput({ speaker: 'af_sarah' }), deps);
    expect(result.source).toBe('local-kokoro');
  });

  it('am_adam kokoro voice is detected automatically', async () => {
    vi.stubGlobal('fetch', mockFetchOk(KOKORO_AUDIO));
    const deps = makeDeps({ localKokoroUrl: 'http://kokoro.local' });
    const result = await generateTtsPreview(makeInput({ speaker: 'am_adam' }), deps);
    expect(result.source).toBe('local-kokoro');
  });

  it('unknown prefix in model/voice falls through as auto engine', async () => {
    const deps = makeDeps();
    const result = await generateTtsPreview(makeInput({ speaker: 'unknown/Ryan' }), deps);
    // Unknown prefix → auto engine → cloud
    expect(result.source).toBe('cloud');
  });

  it('result includes latencyMs field', async () => {
    const deps = makeDeps();
    const result = await generateTtsPreview(makeInput(), deps);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('generateTtsPreview — GPU + Kokoro cascade', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers GPU over local Kokoro for auto engine voices', async () => {
    vi.stubGlobal('fetch', mockFetchOk(GPU_AUDIO)); // GPU succeeds
    const deps = makeDeps({
      gpuEndpoint: 'http://gpu.example.com',
      localKokoroUrl: 'http://kokoro.local',
    });
    // 'serena' is not a kokoro-style voice (no xx_yy pattern) → auto engine → GPU first
    const result = await generateTtsPreview(makeInput({ speaker: 'serena' }), deps);
    expect(result.source).toBe('gpu');
  });

  it('kokoro-style voice goes directly to local Kokoro (GPU is skipped)', async () => {
    let gpuCallCount = 0;
    let kokoroCallCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('gpu.example.com')) {
        gpuCallCount++;
        return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('error') });
      }
      kokoroCallCount++;
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(KOKORO_AUDIO.buffer.slice(
          KOKORO_AUDIO.byteOffset,
          KOKORO_AUDIO.byteOffset + KOKORO_AUDIO.byteLength,
        )),
        text: () => Promise.resolve(''),
      });
    }));
    const deps = makeDeps({
      gpuEndpoint: 'http://gpu.example.com',
      localKokoroUrl: 'http://kokoro.local',
    });
    // am_adam → kokoro engine → GPU is NOT tried; Kokoro goes directly
    const result = await generateTtsPreview(makeInput({ speaker: 'am_adam' }), deps);
    expect(result.source).toBe('local-kokoro');
    expect(gpuCallCount).toBe(0);
    expect(kokoroCallCount).toBe(1);
  });

  it('falls to Kokoro when GPU fails (auto engine with both set)', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes('gpu.example.com')) {
        return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('error') });
      }
      // Kokoro URL
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(KOKORO_AUDIO.buffer.slice(
          KOKORO_AUDIO.byteOffset,
          KOKORO_AUDIO.byteOffset + KOKORO_AUDIO.byteLength,
        )),
        text: () => Promise.resolve(''),
      });
    }));
    const deps = makeDeps({
      gpuEndpoint: 'http://gpu.example.com',
      localKokoroUrl: 'http://kokoro.local',
    });
    // 'serena' → auto engine → GPU tried first, fails, Kokoro second
    const result = await generateTtsPreview(makeInput({ speaker: 'serena' }), deps);
    expect(result.source).toBe('local-kokoro');
    expect(callCount).toBe(2);
  });
});
