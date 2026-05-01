/**
 * Property-based testing helpers for AI Gateway.
 *
 * Uses fast-check style generators to create random inputs
 * and verify invariants across many test cases.
 *
 * @example
 * ```ts
 * import { genLanguageCode, genAudioBuffer, property } from './property-test';
 *
 * it('should handle any valid language code', () => {
 *   forAll(genLanguageCode, (code) => {
 *     const result = detectLanguage(`Text in ${code}`);
 *     expect(result).toBeDefined();
 *   });
 * });
 * ```
 */

// ── Random Generators ────────────────────────────────────────────────────────

/**
 * Generate a random string of given length range.
 */
export function genString(minLen = 1, maxLen = 100): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
  const length = minLen + Math.floor(Math.random() * (maxLen - minLen + 1));
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Generate a random language code (ISO 639-1 style).
 */
export function genLanguageCode(): string {
  const codes = [
    'en',
    'fr',
    'es',
    'de',
    'pt',
    'it',
    'nl',
    'ru',
    'zh',
    'ja',
    'ko',
    'ar',
    'hi',
    'tr',
    'pl',
  ];
  const code = codes[Math.floor(Math.random() * codes.length)];
  // Sometimes add region
  return Math.random() > 0.7 ? `${code}-${code.toUpperCase()}` : code;
}

/**
 * Generate a random audio-like buffer.
 */
export function genAudioBuffer(minBytes = 100, maxBytes = 10000): Buffer {
  const length = minBytes + Math.floor(Math.random() * (maxBytes - minBytes));
  return Buffer.from(crypto.getRandomValues(new Uint8Array(length)));
}

/**
 * Generate a random message array for LLM tests.
 */
export function genMessages(minCount = 1, maxCount = 5) {
  const roles = ['system', 'user', 'assistant'] as const;
  const count = minCount + Math.floor(Math.random() * (maxCount - minCount + 1));

  return Array.from({ length: count }, () => ({
    role: roles[Math.floor(Math.random() * roles.length)],
    content: genString(10, 500),
  }));
}

/**
 * Generate a random number in range.
 */
export function genNumber(min = 0, max = 1000): number {
  return min + Math.random() * (max - min);
}

/**
 * Generate a random boolean.
 */
export function genBoolean(): boolean {
  return Math.random() > 0.5;
}

/**
 * Generate a random temperature (0-2).
 */
export function genTemperature(): number {
  return Math.random() * 2;
}

// ── Property Test Runner ─────────────────────────────────────────────────────

/**
 * Run a property test with many random inputs.
 *
 * @example
 * ```ts
 * await property('should sanitize all strings', 100, () => {
 *   const input = genString(0, 10000);
 *   const result = sanitizePrompt(input);
 *   expect(result.length).toBeLessThanOrEqual(4096);
 * });
 * ```
 */
export async function property(
  name: string,
  iterations: number,
  fn: (iteration: number) => void | Promise<void>,
): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < iterations; i++) {
    try {
      await fn(i);
      passed++;
    } catch (error) {
      failed++;
      console.error(`Property "${name}" failed on iteration ${i}:`, error);
      throw error;
    }
  }

  console.log(`✅ Property "${name}": ${passed}/${iterations} passed`);
}

/**
 * Run a property test for all combinations of two generators.
 */
export async function property2<A, B>(
  name: string,
  genA: () => A,
  genB: () => B,
  iterations: number,
  fn: (a: A, b: B, iteration: number) => void | Promise<void>,
): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    const a = genA();
    const b = genB();
    await fn(a, b, i);
  }

  console.log(`✅ Property "${name}": ${iterations} passed`);
}

// ── Invariant Checkers ───────────────────────────────────────────────────────

/**
 * Check that a function is idempotent (f(f(x)) === f(x)).
 */
export function checkIdempotent<T, R>(fn: (input: T) => R, input: T): boolean {
  const first = fn(input);
  const second = fn(first as unknown as T);
  return JSON.stringify(first) === JSON.stringify(second);
}

/**
 * Check that a function preserves certain properties.
 */
export function checkProperty<T>(
  fn: (input: T) => T,
  check: (output: T) => boolean,
  input: T,
): boolean {
  const output = fn(input);
  return check(output);
}
