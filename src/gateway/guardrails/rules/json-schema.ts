import type { JsonSchemaRule, RuleContext, RuleResult } from '../types';

/**
 * Minimal JSON Schema validator — handles the subset Portkey uses:
 * type, properties, required, items, enum, minimum, maximum, minLength, maxLength.
 * Good enough for validating LLM output shapes without a heavy dependency.
 */
function validate(value: unknown, schema: Record<string, unknown>, path = ''): string | null {
  const type = schema.type as string | undefined;

  if (type) {
    const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actualType !== type) {
      return `${path || 'value'} must be ${type}, got ${actualType}`;
    }
  }

  if (schema.enum) {
    const allowed = schema.enum as unknown[];
    if (!allowed.includes(value)) {
      return `${path || 'value'} must be one of [${allowed.join(', ')}], got ${JSON.stringify(value)}`;
    }
  }

  if (type === 'string' && typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return `${path} must have at least ${schema.minLength} characters`;
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return `${path} must have at most ${schema.maxLength} characters`;
    }
  }

  if (type === 'number' && typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `${path} must be >= ${schema.minimum}`;
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `${path} must be <= ${schema.maximum}`;
    }
  }

  if (type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) {
          return `${path ? path + '.' : ''}${key} is required`;
        }
      }
    }

    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, subSchema] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
        if (key in obj) {
          const err = validate(obj[key], subSchema, path ? `${path}.${key}` : key);
          if (err) return err;
        }
      }
    }
  }

  if (type === 'array' && Array.isArray(value)) {
    if (schema.items && typeof schema.items === 'object') {
      const itemSchema = schema.items as Record<string, unknown>;
      for (let i = 0; i < value.length; i++) {
        const err = validate(value[i], itemSchema, `${path}[${i}]`);
        if (err) return err;
      }
    }
  }

  return null;
}

export function runJsonSchema(rule: JsonSchemaRule, ctx: RuleContext): RuleResult {
  // Only meaningful on responses — parse the text as JSON first
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.text);
  } catch {
    const pass = rule.not ? true : false;
    return {
      pass,
      reason: pass ? undefined : 'Response is not valid JSON',
    };
  }

  const err = validate(parsed, rule.schema);
  const matches = err === null;
  const pass = rule.not ? !matches : matches;

  return {
    pass,
    reason: pass ? undefined : rule.not
      ? 'Response matched forbidden schema'
      : `Response failed schema validation: ${err}`,
  };
}
