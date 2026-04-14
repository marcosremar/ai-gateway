/**
 * Test utilities — reusable helpers for AI Gateway tests.
 *
 * Import these in any test file to avoid duplicating mock setup.
 *
 * @example
 * ```ts
 * import { mockProvider, fakeGPU, describeWithGPU } from '../test-utils';
 * ```
 */

import { vi } from 'vitest';

// ── Provider Mocking ────────────────────────────────────────────────────────

/**
 * Create a mock AI provider that returns predefined responses.
 *
 * @example
 * ```ts
 * const sttProvider = mockSTTProvider({ text: 'Hello', latencyMs: 100 });
 * const result = await sttProvider.transcribe({ audio: buffer });
 * expect(result.text).toBe('Hello');
 * ```
 */
export function mockSTTProvider(response: { text: string; language?: string; latencyMs?: number }) {
  return {
    transcribe: vi.fn().mockResolvedValue({
      text: response.text,
      language: response.language ?? 'en',
      latencyMs: response.latencyMs ?? 100,
    }),
  };
}

/**
 * Create a mock LLM provider.
 */
export function mockLLMProvider(response: { content: string; model?: string; latencyMs?: number }) {
  return {
    chat: vi.fn().mockResolvedValue({
      content: response.content,
      role: 'assistant',
      model: response.model ?? 'mock-model',
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      latencyMs: response.latencyMs ?? 200,
    }),
  };
}

/**
 * Create a mock TTS provider.
 */
export function mockTTSProvider(response: { audio?: Buffer; latencyMs?: number }) {
  return {
    synthesize: vi.fn().mockResolvedValue({
      audio: response.audio ?? Buffer.from('mock-audio'),
      contentType: 'audio/wav',
      latencyMs: response.latencyMs ?? 150,
    }),
  };
}

/**
 * Create a provider that throws an error.
 */
export function mockFailingProvider(error: Error | string) {
  const err = typeof error === 'string' ? new Error(error) : error;
  return {
    transcribe: vi.fn().mockRejectedValue(err),
    chat: vi.fn().mockRejectedValue(err),
    synthesize: vi.fn().mockRejectedValue(err),
  };
}

// ── GPU Mocking ──────────────────────────────────────────────────────────────

/**
 * Create a fake GPU instance with configurable behavior.
 *
 * @example
 * ```ts
 * const gpu = fakeGPU({ bootTimeMs: 500, healthy: true });
 * await gpu.boot();
 * expect(gpu.isHealthy()).toBe(true);
 * ```
 */
export function fakeGPU(
  options: {
    bootTimeMs?: number;
    healthy?: boolean;
    id?: string;
  } = {},
) {
  const bootTimeMs = options.bootTimeMs ?? 100;
  const healthy = options.healthy ?? true;
  const id = options.id ?? `fake-gpu-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    boot: vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ id, status: 'running' }), bootTimeMs),
          ),
      ),
    terminate: vi.fn().mockResolvedValue({ id, status: 'terminated' }),
    isHealthy: vi.fn().mockResolvedValue(healthy),
    getStatus: vi.fn().mockResolvedValue({
      id,
      status: 'running',
      healthy,
      endpoint: `https://fake-${id}.example.com:8000`,
    }),
  };
}

// ── State Store Mock ────────────────────────────────────────────────────────

/**
 * Create an in-memory mock state store that implements the StateStore interface.
 */
export function mockStateStore(initialState: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initialState));

  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key))),
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn().mockImplementation((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn().mockImplementation((prefix: string) =>
      Promise.resolve(
        Array.from(store.entries())
          .filter(([k]) => k.startsWith(prefix))
          .map(([, v]) => v),
      ),
    ),
    _getStore: () => store, // Access for assertions
  };
}

// ── Time Mocking ────────────────────────────────────────────────────────────

/**
 * Advance time by a given amount (useful for testing timeouts, cooldowns, etc.).
 */
export function advanceTime(ms: number) {
  vi.advanceTimersByTime(ms);
}

/**
 * Run all pending timers (useful for flushing async operations).
 */
export function flushTimers() {
  vi.runAllTimersAsync();
}

// ── Console Suppression ─────────────────────────────────────────────────────

/**
 * Suppress console output during a test (prevents log noise).
 *
 * @example
 * ```ts
 * it('should log errors', async () => {
 *   using _log = suppressConsole();
 *   await functionThatLogs();
 *   // No console output in test run
 * });
 * ```
 */
export function suppressConsole() {
  const originalConsole = { ...console };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.info = () => {};

  return {
    [Symbol.dispose]() {
      Object.assign(console, originalConsole);
    },
  };
}

// ── HTTP Mocking ────────────────────────────────────────────────────────────

/**
 * Mock a fetch response for provider API tests.
 */
export function mockFetchResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Map(Object.entries(headers)),
  };
}

// ── Retry Helpers ───────────────────────────────────────────────────────────

/**
 * Wait for a condition to become true (polling).
 * Useful for async state checks in tests.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 50;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
