import { createLogger } from '../../logger';
import { recordGuardrailPass, recordGuardrailBlock, recordGuardrailAudit } from './stats';
import type {
  GuardrailEngineConfig,
  GuardrailRule,
  GuardrailHook,
  RuleContext,
  EngineResult,
} from './types';
import { runRegexMatch } from './rules/regex-match';
import { runJsonSchema } from './rules/json-schema';
import { runContainsCode } from './rules/contains-code';
import { runWebhook } from './rules/webhook';
import { runNotNull } from './rules/not-null';
import { runModelWhitelist } from './rules/model-whitelist';

const log = createLogger('guardrail-engine');

/**
 * Extracts plain text from an OpenAI-format request body.
 * Concatenates all message contents into a single string.
 */
export function extractRequestText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.messages)) {
    return (b.messages as Array<{ content?: unknown }>)
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof b.prompt === 'string') return b.prompt;
  return '';
}

/**
 * Largest serialized response body we will attempt to `JSON.parse` while
 * extracting text. A response far larger than any real LLM completion is
 * almost certainly not JSON we need to introspect; parsing multi-MB strings
 * just to extract a verdict is a CPU-spike vector, so we treat oversized
 * bodies as opaque text instead of parsing them.
 */
const MAX_PARSEABLE_RESPONSE_CHARS = 1_000_000;

/**
 * Extracts plain text from an OpenAI-format response body.
 */
export function extractResponseText(body: unknown): string {
  if (typeof body === 'string') {
    // Don't JSON.parse pathologically large bodies (CPU amplification).
    if (body.length > MAX_PARSEABLE_RESPONSE_CHARS) return body;
    // Try to parse as JSON first (response might be serialized)
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      return extractResponseText(parsed);
    } catch {
      return body;
    }
  }
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.choices)) {
    return (b.choices as Array<{ message?: { content?: string }; text?: string }>)
      .map(c => c.message?.content ?? c.text ?? '')
      .filter(Boolean)
      .join('\n');
  }
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  return '';
}

/**
 * Evaluates all rules applicable to the given hook.
 * Stops at the first failing rule.
 */
async function runRules(
  rules: GuardrailRule[],
  ctx: RuleContext,
): Promise<EngineResult> {
  for (const rule of rules) {
    if (!rule.hooks.includes(ctx.hook)) continue;

    try {
      let result: { pass: boolean; reason?: string };

      switch (rule.type) {
        case 'regex':
          result = runRegexMatch(rule, ctx);
          break;
        case 'jsonSchema':
          result = runJsonSchema(rule, ctx);
          break;
        case 'containsCode':
          result = runContainsCode(rule, ctx);
          break;
        case 'webhook':
          result = await runWebhook(rule, ctx);
          break;
        case 'notNull':
          result = runNotNull(rule, ctx);
          break;
        case 'modelWhitelist':
          result = runModelWhitelist(rule, ctx);
          break;
        default:
          continue;
      }

      if (!result.pass) {
        return {
          pass: false,
          reason: result.reason,
          failedRule: rule.type,
        };
      }
    } catch (err) {
      // Rule threw unexpectedly — log and continue (fail open)
      log.warn(`Rule "${rule.type}" threw unexpectedly, skipping:`, err);
    }
  }

  return { pass: true };
}

/**
 * GuardrailEngine — the main entry point for rule evaluation.
 *
 * Usage:
 *   const engine = new GuardrailEngine({ rules: [...], action: 'block' });
 *   const result = await engine.runBeforeRequest(requestBody, model);
 *   if (!result.pass && engine.shouldBlock()) {
 *     return { status: 400, body: { error: { message: result.reason } } };
 *   }
 */
export class GuardrailEngine {
  private readonly config: GuardrailEngineConfig;

  constructor(config: GuardrailEngineConfig) {
    this.config = config;
  }

  get action() {
    return this.config.action ?? 'block';
  }

  /** Run beforeRequest rules against the incoming request body */
  async runBeforeRequest(body: unknown, model?: string): Promise<EngineResult> {
    if (this.config.rules.length === 0) return { pass: true };

    const text = extractRequestText(body);
    const ctx: RuleContext = {
      text,
      requestBody: body,
      model,
      hook: 'beforeRequest',
    };

    const result = await runRules(this.config.rules, ctx);

    if (!result.pass) {
      log.warn({ rule: result.failedRule, reason: result.reason, model }, 'beforeRequest guardrail blocked');
      if (this.action === 'block') recordGuardrailBlock(result.failedRule ?? 'unknown');
      else recordGuardrailAudit(result.failedRule ?? 'unknown');
    } else {
      recordGuardrailPass();
    }

    return result;
  }

  /** Run afterResponse rules against the LLM response body */
  async runAfterResponse(responseBody: unknown, model?: string): Promise<EngineResult> {
    if (this.config.rules.length === 0) return { pass: true };

    const text = extractResponseText(responseBody);
    const ctx: RuleContext = {
      text,
      model,
      hook: 'afterResponse',
    };

    const result = await runRules(this.config.rules, ctx);

    if (!result.pass) {
      log.warn({ rule: result.failedRule, reason: result.reason, model }, 'afterResponse guardrail blocked');
      if (this.action === 'block') recordGuardrailBlock(result.failedRule ?? 'unknown');
      else recordGuardrailAudit(result.failedRule ?? 'unknown');
    } else {
      recordGuardrailPass();
    }

    return result;
  }

  /**
   * Run beforeRequest rules with raw text (for when text is already extracted).
   * Used internally by the pipeline plugin.
   */
  async runBeforeRequestText(text: string, model?: string): Promise<EngineResult> {
    if (this.config.rules.length === 0) return { pass: true };

    const ctx: RuleContext = { text, model, hook: 'beforeRequest' };
    const result = await runRules(this.config.rules, ctx);
    if (!result.pass) {
      if (this.action === 'block') recordGuardrailBlock(result.failedRule ?? 'unknown');
      else recordGuardrailAudit(result.failedRule ?? 'unknown');
    } else {
      recordGuardrailPass();
    }
    return result;
  }

  /** Run afterResponse rules with raw text */
  async runAfterResponseText(text: string, model?: string): Promise<EngineResult> {
    if (this.config.rules.length === 0) return { pass: true };

    const ctx: RuleContext = { text, model, hook: 'afterResponse' };
    const result = await runRules(this.config.rules, ctx);
    if (!result.pass) {
      if (this.action === 'block') recordGuardrailBlock(result.failedRule ?? 'unknown');
      else recordGuardrailAudit(result.failedRule ?? 'unknown');
    } else {
      recordGuardrailPass();
    }
    return result;
  }
}
