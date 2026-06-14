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
 */
export function validateInput<T>(input: unknown, schema: z.ZodType<T>): ValidationResult<T> {
  const result = schema.safeParse(input);

  if (result.success) {
    return { ok: true, data: result.data };
  }

  const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
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

  // Common request schemas
  Pagination: z.object({
    page: z.number().int().positive().default(1),
    limit: z.number().int().min(1).max(100).default(20),
  }),

  Sort: z.object({
    field: z.string(),
    order: z.enum(['asc', 'desc']).default('asc'),
  }),

  Filter: z.record(z.string(), z.unknown()),
} as const;
