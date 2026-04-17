/**
 * Rule-based guardrails — typed interfaces for the guardrail engine.
 *
 * Inspired by Portkey's plugin system: rules run as beforeRequest / afterResponse
 * hooks. Each rule returns a verdict; the engine decides what to do with it.
 */

// ── Rule definitions ─────────────────────────────────────────────────────────

export type GuardrailHook = 'beforeRequest' | 'afterResponse';

/** Result returned by any guardrail rule */
export interface RuleResult {
  /** true = request/response is allowed to continue */
  pass: boolean;
  /** Human-readable reason, used in block responses and logs */
  reason?: string;
}

/** Context passed to every rule during evaluation */
export interface RuleContext {
  /** The text being evaluated (extracted from request or response) */
  text: string;
  /** Original request body (raw, for rules that need the full shape) */
  requestBody?: unknown;
  /** HTTP model name from the request */
  model?: string;
  /** Which hook is running */
  hook: GuardrailHook;
}

// ── Individual rule configs ───────────────────────────────────────────────────

/** Checks if text matches (or does NOT match) a regex */
export interface RegexMatchRule {
  type: 'regex';
  /** Regex pattern string */
  pattern: string;
  /** When true, the verdict is inverted: rule passes when text does NOT match */
  not?: boolean;
  /** Which hooks to run on */
  hooks: GuardrailHook[];
}

/** Validates LLM response JSON against a JSON Schema (afterResponse only) */
export interface JsonSchemaRule {
  type: 'jsonSchema';
  /** JSON Schema object to validate against */
  schema: Record<string, unknown>;
  /** When true, verdict is inverted: passes when response does NOT match schema */
  not?: boolean;
  hooks: GuardrailHook[];
}

/** Detects programming code patterns in text */
export interface ContainsCodeRule {
  type: 'containsCode';
  /** Language to detect (or 'any' for any language) */
  language?: 'sql' | 'python' | 'javascript' | 'typescript' | 'html' | 'any';
  /** When true, passes only when code IS present (use to require code) */
  not?: boolean;
  hooks: GuardrailHook[];
}

/** Calls an external HTTP endpoint to decide pass/fail */
export interface WebhookRule {
  type: 'webhook';
  /** POST target URL */
  url: string;
  /** Optional headers to send with the webhook request */
  headers?: Record<string, string>;
  /** Timeout in ms (default: 3000) */
  timeoutMs?: number;
  hooks: GuardrailHook[];
}

/** Ensures the text is non-empty */
export interface NotNullRule {
  type: 'notNull';
  /** When true, passes only when content IS null/empty */
  not?: boolean;
  hooks: GuardrailHook[];
}

/** Allows only specific models through */
export interface ModelWhitelistRule {
  type: 'modelWhitelist';
  /** List of allowed model names */
  models: string[];
  /** When true, listed models are BLOCKED instead of allowed */
  not?: boolean;
  /** Only runs on beforeRequest */
  hooks: GuardrailHook[];
}

/** Union of all rule types */
export type GuardrailRule =
  | RegexMatchRule
  | JsonSchemaRule
  | ContainsCodeRule
  | WebhookRule
  | NotNullRule
  | ModelWhitelistRule;

// ── Engine config ─────────────────────────────────────────────────────────────

/** What the engine does when a rule fails */
export type GuardrailAction = 'block' | 'audit';

export interface GuardrailEngineConfig {
  /** Rules to evaluate */
  rules: GuardrailRule[];
  /**
   * Default action when a rule fails:
   * - 'block' → return HTTP 400 to caller
   * - 'audit' → log and continue
   */
  action?: GuardrailAction;
}

/** Result of running all applicable rules for a hook */
export interface EngineResult {
  /** true = all rules passed (or no rules applied) */
  pass: boolean;
  /** First failing rule's reason */
  reason?: string;
  /** Name/type of the rule that failed */
  failedRule?: string;
}
