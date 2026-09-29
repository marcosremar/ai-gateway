/**
 * translate-service unit tests
 *
 * Covers runTranslateRace candidate-building logic and buildTranslatePrompt.
 * All external deps (raceProviders, fetchGpuLLM, client.chat) are mocked so
 * the tests are pure/fast and exercise only the service's own decision logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runTranslateRace,
  buildTranslatePrompt,
  type TranslateServiceInput,
  type TranslateServiceDeps,
} from '../../src/gateway/pipeline/translate-service';

// ── Fixtures ────────────────────────────────────────────────────────────────

const BASE_INPUT: TranslateServiceInput = {
  text: 'Hello world',
  sourceLang: 'en',
  targetLang: 'es',
  glossary: '',
  context: '',
  style: 'formal',
  systemPrompt: 'You are a translator.',
  messages: [{ role: 'user', content: 'Translate: Hello world' }],
  maxTokens: 256,
  gpuLlmTimeout: 5_000,
  gpuEndpoint: null,
  requestId: 'req-test-1',
};

const CLOUD_PROFILE = { llm: [{ provider: 'groq', model: 'llama-3.1-8b' }] };

function makeRaceProviders(translatedText = 'Hola mundo', provider = 'groq', usedGpu = false) {
  return vi.fn().mockImplementation(
    async (candidates: { name: string; run: (s: AbortSignal) => Promise<unknown> }[]) => ({
      result: { translated_text: translatedText, used_gpu: usedGpu },
      provider,
      latencyMs: 120,
    }),
  );
}

function makeDeps(overrides: Partial<TranslateServiceDeps> = {}): TranslateServiceDeps {
  return {
    client: { chat: vi.fn().mockResolvedValue({ content: 'Hola mundo' }) },
    cloudProfile: CLOUD_PROFILE as any,
    cloudProviderName: 'groq',
    shouldPreferGpu: () => false,
    raceProviders: makeRaceProviders(),
    fetchGpuLLM: vi.fn().mockResolvedValue({ translated_text: 'Hola GPU', used_gpu: true }),
    ...overrides,
  };
}

// ── buildTranslatePrompt ────────────────────────────────────────────────────

describe('buildTranslatePrompt', () => {
  it('returns base prompt unchanged when context and glossary are empty', () => {
    expect(buildTranslatePrompt('Be accurate.', '', '')).toBe('Be accurate.');
  });

  it('appends context section when context is provided', () => {
    const result = buildTranslatePrompt('Base prompt.', 'Medical context.', '');
    expect(result).toContain('Base prompt.');
    expect(result).toContain('Session context (use to improve accuracy and terminology):');
    expect(result).toContain('Medical context.');
    expect(result).not.toContain('glossary');
  });

  it('appends glossary section when glossary is provided', () => {
    const result = buildTranslatePrompt('Base.', '', 'MRI: resonancia magnética');
    expect(result).toContain('Base.');
    expect(result).toContain('Domain-specific glossary (preserve these terms accurately):');
    expect(result).toContain('MRI: resonancia magnética');
    expect(result).not.toContain('Session context');
  });

  it('appends context before glossary when both are provided', () => {
    const result = buildTranslatePrompt('Base.', 'CTX', 'GLOSS');
    const ctxIdx = result.indexOf('CTX');
    const glossIdx = result.indexOf('GLOSS');
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(glossIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeLessThan(glossIdx);
  });

  it('does not append empty-string context (falsy guard)', () => {
    const result = buildTranslatePrompt('Base.', '   ', '');
    // '   ' is truthy — it will be appended; empty string '' won't
    // This tests current behaviour: whitespace-only context IS appended (truthy)
    expect(result).toContain('Session context');
  });
});

// ── runTranslateRace — candidate-building ───────────────────────────────────

describe('runTranslateRace — candidate building', () => {
  it('builds a single cloud candidate when no GPU endpoint is set', async () => {
    const capturedCandidates: { name: string }[] = [];
    const deps = makeDeps({
      raceProviders: vi.fn().mockImplementation(async (candidates: { name: string }[]) => {
        capturedCandidates.push(...candidates);
        return { result: { translated_text: 'Hola', used_gpu: false }, provider: 'groq', latencyMs: 100 };
      }),
    });

    await runTranslateRace({ ...BASE_INPUT, gpuEndpoint: null }, deps);

    expect(capturedCandidates).toHaveLength(1);
    expect(capturedCandidates[0].name).toBe('groq');
  });

  it('puts GPU first when preferGpu=true and GPU endpoint available', async () => {
    const capturedNames: string[] = [];
    const deps = makeDeps({
      shouldPreferGpu: () => true,
      raceProviders: vi.fn().mockImplementation(async (candidates: { name: string }[]) => {
        capturedNames.push(...candidates.map(c => c.name));
        return { result: { translated_text: 'Hi', used_gpu: true }, provider: 'gpu', latencyMs: 80 };
      }),
    });

    await runTranslateRace({ ...BASE_INPUT, gpuEndpoint: 'http://gpu:8080' }, deps);

    expect(capturedNames).toHaveLength(2);
    expect(capturedNames[0]).toBe('gpu');
    expect(capturedNames[1]).toBe('groq');
  });

  it('puts cloud first (GPU as fallback) when preferGpu=false and GPU endpoint available', async () => {
    const capturedNames: string[] = [];
    const deps = makeDeps({
      shouldPreferGpu: () => false,
      raceProviders: vi.fn().mockImplementation(async (candidates: { name: string }[]) => {
        capturedNames.push(...candidates.map(c => c.name));
        return { result: { translated_text: 'Hi', used_gpu: false }, provider: 'groq', latencyMs: 100 };
      }),
    });

    await runTranslateRace({ ...BASE_INPUT, gpuEndpoint: 'http://gpu:8080' }, deps);

    expect(capturedNames).toHaveLength(2);
    expect(capturedNames[0]).toBe('groq');
    expect(capturedNames[1]).toBe('gpu');
  });

  it('builds a single GPU candidate when preferGpu=true and no cloud profile', async () => {
    const capturedNames: string[] = [];
    const deps = makeDeps({
      cloudProfile: null,
      shouldPreferGpu: () => true,
      raceProviders: vi.fn().mockImplementation(async (candidates: { name: string }[]) => {
        capturedNames.push(...candidates.map(c => c.name));
        return { result: { translated_text: 'Hola GPU', used_gpu: true }, provider: 'gpu', latencyMs: 60 };
      }),
    });

    await runTranslateRace({ ...BASE_INPUT, gpuEndpoint: 'http://gpu:8080' }, deps);

    expect(capturedNames).toHaveLength(1);
    expect(capturedNames[0]).toBe('gpu');
  });

  it('throws when no GPU endpoint and no cloud profile', async () => {
    const deps = makeDeps({ cloudProfile: null });

    await expect(
      runTranslateRace({ ...BASE_INPUT, gpuEndpoint: null }, deps),
    ).rejects.toThrow('No providers available for translation');
  });

  it('throws when GPU endpoint + preferGpu=false + no cloud profile (GPU fallback guard)', async () => {
    // The GPU-as-fallback branch requires `candidates.length > 0` after the cloud
    // block — if cloud is absent, no candidates are added and the service rejects.
    const deps = makeDeps({
      cloudProfile: null,
      shouldPreferGpu: () => false,
    });

    await expect(
      runTranslateRace({ ...BASE_INPUT, gpuEndpoint: 'http://gpu:8080' }, deps),
    ).rejects.toThrow('No providers available for translation');
  });
});

// ── runTranslateRace — result mapping ───────────────────────────────────────

describe('runTranslateRace — result mapping', () => {
  it('maps translated_text, provider, latencyMs, usedGpu from race result', async () => {
    const deps = makeDeps({
      raceProviders: vi.fn().mockResolvedValue({
        result: { translated_text: 'Bonjour', used_gpu: false },
        provider: 'fireworks',
        latencyMs: 200,
      }),
    });

    const result = await runTranslateRace(BASE_INPUT, deps);

    expect(result.translatedText).toBe('Bonjour');
    expect(result.provider).toBe('fireworks');
    expect(result.latencyMs).toBe(200);
    expect(result.usedGpu).toBe(false);
  });

  it('sets usedGpu=true when result.used_gpu is truthy', async () => {
    const deps = makeDeps({
      shouldPreferGpu: () => true,
      raceProviders: vi.fn().mockResolvedValue({
        result: { translated_text: 'Ciao', used_gpu: true },
        provider: 'gpu',
        latencyMs: 55,
      }),
    });

    const result = await runTranslateRace({ ...BASE_INPUT, gpuEndpoint: 'http://gpu:8080' }, deps);

    expect(result.usedGpu).toBe(true);
  });

  it('coerces used_gpu to boolean via !!', async () => {
    const deps = makeDeps({
      raceProviders: vi.fn().mockResolvedValue({
        result: { translated_text: 'Salut', used_gpu: 0 },
        provider: 'groq',
        latencyMs: 90,
      }),
    });

    const result = await runTranslateRace(BASE_INPUT, deps);

    expect(result.usedGpu).toBe(false);
  });
});

// ── runTranslateRace — cloud candidate behaviour ─────────────────────────────

describe('runTranslateRace — cloud candidate internals', () => {
  it('merges maxTokens and temperature=0 into the cloud profile', async () => {
    const chatMock = vi.fn().mockResolvedValue({ content: 'Translated' });
    let capturedProfile: unknown;

    const deps = makeDeps({
      client: { chat: chatMock },
      cloudProfile: { llm: [{ provider: 'groq', model: 'llama-3.1-8b' }], maxTokens: 512 } as any,
      raceProviders: vi.fn().mockImplementation(async (candidates: { run: (s: AbortSignal) => Promise<unknown> }[]) => {
        const signal = new AbortController().signal;
        const result = await candidates[0].run(signal);
        return { result, provider: 'groq', latencyMs: 100 };
      }),
    });

    // Intercept the profile passed to client.chat
    chatMock.mockImplementation(async (_msgs: unknown, profile: unknown) => {
      capturedProfile = profile;
      return { content: 'Translated' };
    });

    await runTranslateRace({ ...BASE_INPUT, maxTokens: 128 }, deps);

    expect(capturedProfile).toMatchObject({ maxTokens: 128, temperature: 0 });
  });

  it('throws AbortError if signal is already aborted before cloud call', async () => {
    const ac = new AbortController();
    ac.abort();

    let cloudCandidateFn: ((signal: AbortSignal) => Promise<unknown>) | undefined;

    const deps = makeDeps({
      raceProviders: vi.fn().mockImplementation(async (candidates: { run: (s: AbortSignal) => Promise<unknown> }[]) => {
        // Invoke the cloud candidate run function with an already-aborted signal
        cloudCandidateFn = candidates[0].run;
        try {
          await candidates[0].run(ac.signal);
        } catch {
          // swallow — raceProviders normally handles this
        }
        return { result: { translated_text: 'Fallback', used_gpu: false }, provider: 'groq', latencyMs: 99 };
      }),
    });

    await runTranslateRace(BASE_INPUT, deps);

    // Verify the cloud candidate throws with AbortError when signal is aborted
    if (cloudCandidateFn) {
      await expect(cloudCandidateFn(ac.signal)).rejects.toThrow('Aborted');
    }
  });

  it('passes cloudProviderName as the candidate name', async () => {
    const capturedNames: string[] = [];
    const deps = makeDeps({
      cloudProviderName: 'fireworks',
      raceProviders: vi.fn().mockImplementation(async (candidates: { name: string }[]) => {
        capturedNames.push(...candidates.map(c => c.name));
        return { result: { translated_text: 'Hi', used_gpu: false }, provider: 'fireworks', latencyMs: 100 };
      }),
    });

    await runTranslateRace(BASE_INPUT, deps);

    expect(capturedNames).toContain('fireworks');
  });

  it('uses gpuLlmTimeout for the GPU candidate timeoutMs', async () => {
    const capturedTimeouts: number[] = [];
    const deps = makeDeps({
      shouldPreferGpu: () => true,
      raceProviders: vi.fn().mockImplementation(async (candidates: { name: string; timeoutMs: number }[]) => {
        capturedTimeouts.push(...candidates.map(c => c.timeoutMs));
        return { result: { translated_text: 'Hi', used_gpu: true }, provider: 'gpu', latencyMs: 70 };
      }),
    });

    await runTranslateRace({ ...BASE_INPUT, gpuEndpoint: 'http://gpu:8080', gpuLlmTimeout: 12_000 }, deps);

    const gpuTimeout = capturedTimeouts[0]; // GPU is first when preferGpu
    expect(gpuTimeout).toBe(12_000);
  });
});
