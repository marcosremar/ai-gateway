/**
 * Test factories — create valid test data with sensible defaults.
 *
 * Fixes: #722-750 (test factories, builders, helpers)
 */

// ── Provider Factories ───────────────────────────────────────────────────────

export function createMockSTTProvider(overrides = {}) {
  return {
    transcribe: vi.fn().mockResolvedValue({
      text: 'Hello world',
      language: 'en',
      confidence: 0.95,
      latencyMs: 234,
      ...overrides,
    }),
  };
}

export function createMockLLMProvider(overrides = {}) {
  return {
    chat: vi.fn().mockResolvedValue({
      content: 'Hello! How can I help?',
      role: 'assistant',
      model: 'mock-model',
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      latencyMs: 567,
      ...overrides,
    }),
    chatStream: vi.fn().mockImplementation(async function* () {
      yield { content: 'Hello', done: false };
      yield { content: '!', done: true };
    }),
  };
}

export function createMockTTSProvider(overrides = {}) {
  return {
    synthesize: vi.fn().mockResolvedValue({
      audio: Buffer.from('mock-audio'),
      contentType: 'audio/wav',
      latencyMs: 345,
      ...overrides,
    }),
  };
}

export function createFailingProvider(error = new Error('Provider failed')) {
  return {
    transcribe: vi.fn().mockRejectedValue(error),
    chat: vi.fn().mockRejectedValue(error),
    synthesize: vi.fn().mockRejectedValue(error),
  };
}

export function createSlowProvider(delayMs = 5000) {
  return {
    chat: vi.fn().mockImplementation(() =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              content: 'Slow response',
              role: 'assistant',
              model: 'slow-model',
              usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
              latencyMs: delayMs,
            }),
          delayMs,
        ),
      ),
    ),
  };
}

// ── GPU Factories ────────────────────────────────────────────────────────────

export function createMockGPU(overrides = {}) {
  return {
    id: `gpu-${Math.random().toString(36).slice(2, 8)}`,
    boot: vi.fn().mockResolvedValue({ id: 'mock-pod', status: 'running' }),
    terminate: vi.fn().mockResolvedValue({ id: 'mock-pod', status: 'terminated' }),
    isHealthy: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockResolvedValue({
      status: 'running',
      healthy: true,
      endpoint: 'https://mock:8000',
      ...overrides,
    }),
    ...overrides,
  };
}

export function createUnhealthyGPU(overrides = {}) {
  return createMockGPU({
    isHealthy: vi.fn().mockResolvedValue(false),
    getStatus: vi.fn().mockResolvedValue({ status: 'error', healthy: false, ...overrides }),
    ...overrides,
  });
}

export function createSlowBootingGPU(bootTimeMs = 60_000) {
  return {
    ...createMockGPU(),
    boot: vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ id: 'mock-pod', status: 'running' }), bootTimeMs)),
    ),
  };
}

// ── State Store Factory ──────────────────────────────────────────────────────

export function createMockStateStore(initialState: Record<string, unknown> = {}) {
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
    _getStore: () => store,
  };
}

// ── Request Factory ──────────────────────────────────────────────────────────

export function createMockRequest(overrides: Partial<MockRequest> = {}): MockRequest {
  return {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-key' },
    body: { model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'Hi' }] },
    rawBody: Buffer.from('{}'),
    ...overrides,
  };
}

export interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: Buffer;
}

// ── Message Builders ─────────────────────────────────────────────────────────

export function buildSystemMessage(content: string) {
  return { role: 'system' as const, content };
}

export function buildUserMessage(content: string) {
  return { role: 'user' as const, content };
}

export function buildAssistantMessage(content: string) {
  return { role: 'assistant' as const, content };
}

export function buildConversation(messages: Array<{ role: string; content: string }>) {
  return messages;
}

// ── Test Helpers ─────────────────────────────────────────────────────────────

/** Suppress all console output during test */
export function silenceConsole() {
  const orig = { ...console };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.info = () => {};
  return { restore: () => Object.assign(console, orig) };
}

/** Advance fake timers */
export function advanceTime(ms: number) {
  vi.advanceTimersByTime(ms);
}

/** Wait for condition to be true */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Create a deferred promise that can be resolved/rejected manually */
export function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
