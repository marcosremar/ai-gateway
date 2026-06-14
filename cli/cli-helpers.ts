/**
 * Pure, side-effect-free helpers for the `ai-gateway` CLI (`bin/ai-gateway.ts`).
 *
 * Extracted here so the parsing/validation logic is unit-testable without
 * importing `bin/ai-gateway.ts` (which runs `main()` at module load). Keep this
 * file dependency-free and free of `process.exit`/console — return values and
 * let the caller decide on output/exit behavior.
 */

/** Process exit codes, mirroring the cost-audit binary's documented scheme.
 *  2 = usage error (bad args/flags); 1 = runtime/HTTP error. */
export const EXIT_USAGE = 2;
export const EXIT_RUNTIME = 1;

/** Result of validating a numeric CLI flag value. */
export interface NumericFlagResult {
  /** Parsed value when valid. */
  value?: number;
  /** Human-readable error when invalid (caller should print + exit EXIT_USAGE). */
  error?: string;
}

/**
 * Validate a numeric flag value instead of silently producing `NaN`.
 *
 * Returns `{ value }` on success or `{ error }` on failure. `undefined`/missing
 * input is treated as "not provided" → `{ value: undefined }` (no error), so the
 * caller can apply its own default.
 *
 * @param raw   the raw string captured for the flag (or undefined if absent)
 * @param flag  the flag name, for the error message (e.g. "-n")
 * @param opts  optional bounds + integer requirement
 */
export function validateNumericFlag(
  raw: string | undefined,
  flag: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): NumericFlagResult {
  if (raw === undefined) return { value: undefined };
  const trimmed = raw.trim();
  if (trimmed === '') return { error: `Invalid value for ${flag}: expected a number, got empty string` };
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    return { error: `Invalid value for ${flag}: "${raw}" is not a number` };
  }
  if (opts.integer && !Number.isInteger(num)) {
    return { error: `Invalid value for ${flag}: "${raw}" must be an integer` };
  }
  if (opts.min !== undefined && num < opts.min) {
    return { error: `Invalid value for ${flag}: ${num} is below the minimum of ${opts.min}` };
  }
  if (opts.max !== undefined && num > opts.max) {
    return { error: `Invalid value for ${flag}: ${num} exceeds the maximum of ${opts.max}` };
  }
  return { value: num };
}

/**
 * Like `getArg`, but rejects a value that is itself a flag.
 *
 * `getArg(args, '-m')` returns the next token even if it starts with `-`, so
 * `chat -m --no-stream` swallows `--no-stream` as the model. This guard returns
 * `undefined` when the next token looks like a flag, matching the cost-audit
 * binary's `getFlag` behavior.
 */
export function getArgSafe(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  if (value.startsWith('-')) return undefined;
  return value;
}

/**
 * Parse and validate the `--max-cost-usd` hourly cost ceiling for `gpu deploy`.
 *
 * Returns `{ value }` (the dollars/hr cap) when valid, `{ error }` when the
 * flag was provided but malformed, or `{ value: undefined }` when absent.
 */
export function parseMaxCostUsd(raw: string | undefined): NumericFlagResult {
  return validateNumericFlag(raw, '--max-cost-usd', { min: 0.000001 });
}

/**
 * Classify a thrown error into a CLI exit code.
 *
 * Usage errors (bad args/flags) should be raised as `UsageError` so they map to
 * EXIT_USAGE (2); everything else (HTTP/runtime/network failures) maps to
 * EXIT_RUNTIME (1).
 */
export function classifyExitCode(err: unknown): number {
  if (err instanceof UsageError) return EXIT_USAGE;
  if (err && typeof err === 'object' && (err as { isUsageError?: boolean }).isUsageError === true) {
    return EXIT_USAGE;
  }
  return EXIT_RUNTIME;
}

/** Error subtype for CLI usage problems (bad/missing args). Maps to EXIT_USAGE. */
export class UsageError extends Error {
  readonly isUsageError = true;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
