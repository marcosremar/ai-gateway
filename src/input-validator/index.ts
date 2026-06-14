/**
 * Input Validator — validates and sanitizes all endpoint inputs.
 *
 * Fixes: #406-420 (input validation), #305-320 (runtime validation)
 *
 * Usage:
 * ```ts
 * import { validateInput, createValidator } from './input-validator';
 *
 * // Validate with schema
 * const result = validateInput(body, ChatRequestSchema);
 * if (!result.ok) return sendError(res, 400, result.error);
 *
 * // Create validator for endpoint
 * const validateChat = createValidator(ChatRequestSchema);
 * const valid = await validateChat(req);
 * ```
 */

import { z } from 'zod';

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; details: string[] };

/**
 * Validate input against a Zod schema.
 *
 * `details` echoes the Zod issue paths (e.g. `messages.0.content: ...`) by
 * default, which is helpful in development but reveals the internal schema
 * shape to clients (schema fingerprinting). Pass `{ exposeDetails: false }`
 * — or set `VALIDATOR_HIDE_DETAILS=1` in the environment — to return a single
 * generic detail string in production while keeping the same result shape.
 */
export function validateInput<T>(
  input: unknown,
  schema: z.ZodType<T>,
  options: { exposeDetails?: boolean } = {},
): ValidationResult<T> {
  const result = schema.safeParse(input);

  if (result.success) {
    return { ok: true, data: result.data };
  }

  const exposeDetails =
    options.exposeDetails ?? process.env.VALIDATOR_HIDE_DETAILS !== '1';

  const details = exposeDetails
    ? result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    : ['Invalid request body'];

  return {
    ok: false,
    error: 'Validation failed',
    details,
  };
}

/**
 * Create a validator function for an endpoint.
 */
export function createValidator<T>(schema: z.ZodType<T>) {
  return (input: unknown): ValidationResult<T> => validateInput(input, schema);
}

/**
 * Validate and sanitize string input.
 *
 * By default an over-length value is silently truncated to `maxLength`. For
 * security-relevant fields pass `rejectOverLength: true` so the caller learns
 * the input was malformed (returns `null`) instead of receiving a mangled,
 * possibly-meaning-changed string.
 */
export function sanitizeString(
  value: string,
  options: { maxLength?: number; pattern?: RegExp; trim?: boolean; rejectOverLength?: boolean } = {},
): string | null {
  let result = options.trim !== false ? value.trim() : value;

  if (options.maxLength && result.length > options.maxLength) {
    if (options.rejectOverLength) return null;
    result = result.slice(0, options.maxLength);
  }

  if (options.pattern && !options.pattern.test(result)) {
    return null;
  }

  return result;
}

/**
 * Luhn (mod-10) checksum validation for a candidate card number.
 *
 * A DLP credit-card regex flags any 13-16 digit run that matches a brand
 * prefix — which false-positives on order IDs, timestamps, and tracking
 * numbers. Gating a "looks like a card" match behind a Luhn check cuts those
 * false positives sharply (a random 16-digit run passes Luhn only ~10% of the
 * time). Non-digit separators (spaces, dashes) are ignored.
 *
 * @returns true iff the digits form a valid Luhn sequence.
 */
export function luhnCheck(candidate: string): boolean {
  const digits = candidate.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  let sum = 0;
  let double = false;
  // Walk right-to-left, doubling every second digit.
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' = 48
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Validate a requested model against an allowlist.
 *
 * Arbitrary `model` strings otherwise flow straight to providers, allowing a
 * caller to route to an unintended/expensive model. Comparison is exact and
 * case-sensitive; pass the configured model set. An empty allowlist returns
 * false (deny-all) rather than allow-all, so a missing/empty config fails
 * closed.
 */
export function isAllowedModel(model: string, allowlist: readonly string[]): boolean {
  if (!model || allowlist.length === 0) return false;
  return allowlist.includes(model);
}

/**
 * Clamp a number into `[min, max]` (#664 helper).
 *
 * `validateNumber` REJECTS an out-of-range value (returns null). For cost-cap
 * fields like `max_tokens` the safer default is often to CLAMP to the ceiling
 * rather than fail the whole request: `max_tokens: 1e9` becomes the configured
 * max instead of a 400. This is the localized primitive a caller can apply at
 * the edge without changing any request schema. Non-finite input returns the
 * `min` (or 0 when no min) so it can never propagate `NaN`/`Infinity` downstream.
 */
export function clampNumber(
  value: number,
  options: { min?: number; max?: number } = {},
): number {
  const min = options.min;
  const max = options.max;
  if (!Number.isFinite(value)) return min ?? 0;
  let out = value;
  if (min != null && out < min) out = min;
  if (max != null && out > max) out = max;
  return out;
}

/**
 * Validate number is within range.
 */
export function validateNumber(
  value: number,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number | null {
  // `isNaN(Infinity)` is false, so a bare `isNaN` check let `Infinity` /
  // `-Infinity` through whenever no min/max bound was supplied — a value that
  // poisons downstream arithmetic (e.g. unbounded `max_tokens`). Require a
  // finite number.
  if (!Number.isFinite(value)) return null;
  if (options.integer && !Number.isInteger(value)) return null;
  if (options.min != null && value < options.min) return null;
  if (options.max != null && value > options.max) return null;
  return value;
}

/**
 * Common validation schemas.
 */
export const Schemas = {
  // String validators
  NonEmptyString: z.string().min(1),
  Email: z.string().email(),
  URL: z.string().url(),
  UUID: z.string().uuid(),

  // Number validators
  PositiveInt: z.number().int().positive(),
  NonNegativeInt: z.number().int().nonnegative(),
  Percentage: z.number().min(0).max(100),

  // Array validators
  NonEmptyArray: (itemSchema: z.ZodType) => z.array(itemSchema).min(1),
  MaxLength: (itemSchema: z.ZodType, max: number) => z.array(itemSchema).max(max),

  /**
   * A string with a hard upper length bound (#662 helper). Unbounded
   * `z.string()` on chat `content` lets a caller push megabytes per message →
   * uncontrolled token/$ spend and memory. This is the reusable bounded variant
   * a schema can drop in (`Schemas.BoundedString(100_000)`).
   */
  BoundedString: (max: number, opts: { min?: number } = {}) => {
    let s = z.string().max(max);
    if (opts.min != null) s = s.min(opts.min);
    return s;
  },

  /**
   * An array with a hard element-count cap (#663 helper). An unbounded
   * `messages` array (or any list flowing into context) explodes cost; this
   * caps it (`Schemas.BoundedArray(item, 200)`).
   */
  BoundedArray: (itemSchema: z.ZodType, max: number, opts: { min?: number } = {}) => {
    let a = z.array(itemSchema).max(max);
    if (opts.min != null) a = a.min(opts.min);
    return a;
  },

  // Common request schemas
  Pagination: z.object({
    page: z.number().int().positive().default(1),
    limit: z.number().int().min(1).max(100).default(20),
  }),

  Sort: z.object({
    field: z.string(),
    order: z.enum(['asc', 'desc']).default('asc'),
  }),

  // Arbitrary-key filter. Convenient but mass-assignment-prone: any attacker
  // key survives validation and can flow into a downstream query. Prefer
  // `ConstrainedFilter([...])` for anything that maps to a query/DB filter.
  Filter: z.record(z.string(), z.unknown()),

  /**
   * Filter object whose keys are restricted to an explicit allowlist. Unknown
   * keys are rejected (not silently dropped), closing the mass-assignment gap
   * in the open `Filter` record. Values are still `unknown` — validate the
   * value type per field at the call site if needed.
   *
   * @example
   * ```ts
   * const QueryFilter = Schemas.ConstrainedFilter(['status', 'createdAfter']);
   * validateInput(req.query, QueryFilter); // rejects { __proto__: ... }
   * ```
   */
  ConstrainedFilter: (allowedKeys: readonly string[]) => {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const key of allowedKeys) shape[key] = z.unknown().optional();
    // `.strict()` makes unrecognized keys a validation ERROR.
    return z.object(shape).strict();
  },
} as const;
