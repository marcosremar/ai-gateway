/**
 * Null-safe utility functions.
 *
 * Fixes: #026-050 (null dereferences), #038-040 (null guards)
 *
 * @example
 * ```ts
 * import { safeGet, safeCall, requireDefined } from './null-safety';
 *
 * const value = safeGet(obj, 'a.b.c', 'default');
 * const result = await safeCall(() => riskyOperation());
 * const key = requireDefined(process.env.API_KEY, 'API_KEY');
 * ```
 */

/**
 * Safely access nested properties without throwing on null/undefined.
 *
 * @example
 * ```ts
 * const city = safeGet(user, 'address.city', 'Unknown');
 * ```
 */
/**
 * Object keys that walk into the prototype chain. A path containing these
 * (e.g. a user-supplied `field` like `__proto__.isAdmin`) should never resolve
 * through `safeGet` — at best it leaks engine internals, at worst it's the
 * read half of a prototype-pollution probe. Treat them as "not found".
 */
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function safeGet<T, D = undefined>(
  obj: unknown,
  path: string,
  defaultValue?: D,
): T | D | undefined {
  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) {
      return defaultValue as D;
    }
    if (UNSAFE_PATH_KEYS.has(key)) {
      return defaultValue as D;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return (current === null || current === undefined)
    ? (defaultValue as D)
    : (current as T);
}

/**
 * Call a function safely, returning a Result instead of throwing.
 *
 * @example
 * ```ts
 * const result = await safeCall(() => fetch(url));
 * if (result.ok) {
 *   console.log(result.value);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */
export async function safeCall<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Sync version of safeCall.
 */
export function safeCallSync<T>(fn: () => T): Result<T> {
  try {
    const value = fn();
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Result type — either success with value or failure with error.
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

/**
 * Require a value to be defined, throwing a descriptive error if not.
 *
 * @example
 * ```ts
 * const apiKey = requireDefined(process.env.GROQ_API_KEY, 'GROQ_API_KEY');
 * ```
 */
export function requireDefined<T>(
  value: T | undefined | null,
  name: string,
): T {
  if (value === undefined || value === null) {
    throw new Error(`Required value '${name}' is not defined`);
  }
  return value;
}

/**
 * Require a string to be non-empty after trimming.
 *
 * @example
 * ```ts
 * const name = requireNonEmpty(process.env.APP_NAME, 'APP_NAME');
 * ```
 */
export function requireNonEmpty(value: string | undefined | null, name: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`Required value '${name}' is empty`);
  }
  return value.trim();
}

/**
 * Safe split — returns empty array instead of throwing on undefined.
 *
 * @example
 * ```ts
 * const parts = safeSplit(credentials.apiKey, ':');
 * ```
 */
export function safeSplit(value: string | undefined | null, separator: string): string[] {
  if (!value) return [];
  return value.split(separator);
}

/**
 * Safe toString — never throws, returns empty string for null/undefined.
 */
export function safeToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Safe number parsing — returns NaN instead of throwing.
 */
export function safeParseInt(value: string | undefined | null, radix = 10): number {
  if (!value) return NaN;
  const result = parseInt(value, radix);
  return isNaN(result) ? NaN : result;
}

/**
 * Safe JSON parse — returns undefined instead of throwing.
 */
export function safeJsonParse<T = unknown>(value: string | undefined | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Safe JSON stringify — never throws, returns empty object string for circular refs.
 */
export function safeJsonStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    return '"[Circular or Unserializable]"';
  }
}

/**
 * Null-coalescing helper with explicit default.
 */
export function coalesce<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

/**
 * Deep null check — returns true if value is not null/undefined at any level.
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Optional chaining for function calls — calls fn only if value is defined.
 */
export function callIfDefined<T, R>(
  value: T | null | undefined,
  fn: (value: T) => R,
  fallback: R,
): R {
  if (value === null || value === undefined) return fallback;
  return fn(value);
}
