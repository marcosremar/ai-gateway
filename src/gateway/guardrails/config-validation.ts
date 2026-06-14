/**
 * Zod validation for operator-supplied GuardrailEngine config.
 *
 * #685-class: a `GuardrailEngineConfig` assembled from a config file / API is
 * otherwise trusted verbatim. A malformed `action` (e.g. the string `"allow"`,
 * a typo, or `undefined`) silently falls through `this.config.action ?? 'block'`
 * — usually fine, but a value like `"audit"` typo'd as `"adit"` would NOT match
 * `=== 'block'` and so quietly STOP blocking. Validate the config shape so a bad
 * `action` fails loud instead of degrading to allow.
 *
 * This is a pure validator (no I/O, no wiring into the live engine) — callers
 * opt in by running it before constructing a `GuardrailEngine`.
 */
import { z } from 'zod';
import type { GuardrailEngineConfig } from './types';

/** Allowed engine actions — exactly the `GuardrailAction` union. */
export const GuardrailActionSchema = z.enum(['block', 'audit']);

const HookSchema = z.enum(['beforeRequest', 'afterResponse']);

/**
 * Per-rule schema. We validate the discriminant + the fields the engine reads;
 * rule-specific bodies (pattern, schema, url, ...) are checked loosely here
 * (the individual rule runners already guard their own inputs) but the `type`
 * MUST be one the engine dispatches, and `hooks` must be a non-empty array of
 * valid hook names — a rule with an unknown type is silently `continue`d by the
 * engine (never runs), which is exactly the "false sense of coverage" we want
 * to surface at config time.
 */
const RuleSchema = z
  .object({
    type: z.enum(['regex', 'jsonSchema', 'containsCode', 'webhook', 'notNull', 'modelWhitelist']),
    hooks: z.array(HookSchema).min(1),
  })
  .passthrough();

export const GuardrailEngineConfigSchema = z.object({
  rules: z.array(RuleSchema),
  action: GuardrailActionSchema.optional(),
  failClosed: z.boolean().optional(),
});

export type GuardrailConfigValidation =
  | { ok: true; config: GuardrailEngineConfig }
  | { ok: false; errors: string[] };

/**
 * Validate a candidate engine config. Returns a discriminated result rather
 * than throwing so callers can choose to reject or fall back to a safe default.
 */
export function validateGuardrailEngineConfig(input: unknown): GuardrailConfigValidation {
  const parsed = GuardrailEngineConfigSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, config: parsed.data as GuardrailEngineConfig };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
