/**
 * Guardrail rule functions — direct unit tests
 *
 * These test the individual rule implementations directly as pure functions,
 * independent of the GuardrailEngine. This catches edge cases (invalid regex,
 * empty inputs, inverted logic) that engine-level tests don't exercise.
 */

import { describe, it, expect } from 'vitest';
import { runRegexMatch } from '../../src/gateway/guardrails/rules/regex-match';
import { runJsonSchema } from '../../src/gateway/guardrails/rules/json-schema';
import { runContainsCode } from '../../src/gateway/guardrails/rules/contains-code';
import { runModelWhitelist } from '../../src/gateway/guardrails/rules/model-whitelist';
import { runNotNull } from '../../src/gateway/guardrails/rules/not-null';
import type { RuleContext } from '../../src/gateway/guardrails/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function ctx(text: string, model?: string, hook: RuleContext['hook'] = 'afterResponse'): RuleContext {
  return { text, model, hook };
}

// ══════════════════════════════════════════════════════════════════════════════
// runRegexMatch
// ══════════════════════════════════════════════════════════════════════════════

describe('runRegexMatch', () => {
  it('passes when text matches pattern (default not=false)', () => {
    const result = runRegexMatch(
      { type: 'regex', pattern: 'hello', hooks: ['afterResponse'] },
      ctx('hello world'),
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('fails when text does not match pattern', () => {
    const result = runRegexMatch(
      { type: 'regex', pattern: 'goodbye', hooks: ['afterResponse'] },
      ctx('hello world'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('goodbye');
  });

  it('is case-insensitive by default', () => {
    const result = runRegexMatch(
      { type: 'regex', pattern: 'HELLO', hooks: ['afterResponse'] },
      ctx('hello world'),
    );
    expect(result.pass).toBe(true);
  });

  it('inverted (not=true): fails when text matches forbidden pattern', () => {
    const result = runRegexMatch(
      { type: 'regex', pattern: 'badword', not: true, hooks: ['afterResponse'] },
      ctx('this contains badword'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('forbidden pattern');
    expect(result.reason).toContain('badword');
  });

  it('inverted (not=true): passes when text does not match forbidden pattern', () => {
    const result = runRegexMatch(
      { type: 'regex', pattern: 'badword', not: true, hooks: ['afterResponse'] },
      ctx('clean text here'),
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('fails gracefully on invalid regex', () => {
    const result = runRegexMatch(
      { type: 'regex', pattern: '(unclosed', hooks: ['afterResponse'] },
      ctx('some text'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('Invalid regex pattern');
  });

  it('handles empty text', () => {
    const result = runRegexMatch(
      { type: 'regex', pattern: '.+', hooks: ['afterResponse'] },
      ctx(''),
    );
    expect(result.pass).toBe(false);
  });

  it('supports multiline patterns', () => {
    const result = runRegexMatch(
      { type: 'regex', pattern: 'credit card', hooks: ['afterResponse'] },
      ctx('Your credit card number is required'),
    );
    expect(result.pass).toBe(true);
  });

  it('reason includes pattern when failing', () => {
    const result = runRegexMatch(
      { type: 'regex', pattern: 'foo\\d+', hooks: ['afterResponse'] },
      ctx('no digits here'),
    );
    expect(result.reason).toContain('foo\\d+');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// runNotNull
// ══════════════════════════════════════════════════════════════════════════════

describe('runNotNull', () => {
  it('passes when text is non-empty', () => {
    const result = runNotNull({ type: 'notNull', hooks: ['afterResponse'] }, ctx('some content'));
    expect(result.pass).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('fails when text is empty string', () => {
    const result = runNotNull({ type: 'notNull', hooks: ['afterResponse'] }, ctx(''));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('empty');
  });

  it('fails when text is only whitespace', () => {
    const result = runNotNull({ type: 'notNull', hooks: ['afterResponse'] }, ctx('   '));
    expect(result.pass).toBe(false);
  });

  it('inverted (not=true): passes when text is empty', () => {
    const result = runNotNull({ type: 'notNull', not: true, hooks: ['afterResponse'] }, ctx(''));
    expect(result.pass).toBe(true);
  });

  it('inverted (not=true): fails when text has content', () => {
    const result = runNotNull(
      { type: 'notNull', not: true, hooks: ['afterResponse'] },
      ctx('unexpected content'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('content was present');
  });

  it('inverted (not=true): passes when text is only whitespace', () => {
    const result = runNotNull({ type: 'notNull', not: true, hooks: ['afterResponse'] }, ctx('\t\n'));
    expect(result.pass).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// runModelWhitelist
// ══════════════════════════════════════════════════════════════════════════════

describe('runModelWhitelist', () => {
  const allowlistRule = {
    type: 'modelWhitelist' as const,
    models: ['gpt-4o', 'llama-3.3-70b'],
    hooks: ['beforeRequest' as const],
  };

  it('passes when model is in the allowlist', () => {
    const result = runModelWhitelist(allowlistRule, ctx('', 'gpt-4o', 'beforeRequest'));
    expect(result.pass).toBe(true);
  });

  it('fails when model is not in the allowlist', () => {
    const result = runModelWhitelist(allowlistRule, ctx('', 'claude-3-5-sonnet', 'beforeRequest'));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('claude-3-5-sonnet');
    expect(result.reason).toContain('allowed list');
  });

  it('reason lists the allowed models on failure', () => {
    const result = runModelWhitelist(allowlistRule, ctx('', 'unknown-model', 'beforeRequest'));
    expect(result.reason).toContain('gpt-4o');
    expect(result.reason).toContain('llama-3.3-70b');
  });

  it('blocklist mode (not=true): passes when model is NOT in the list', () => {
    const blocklistRule = { ...allowlistRule, not: true };
    const result = runModelWhitelist(blocklistRule, ctx('', 'some-safe-model', 'beforeRequest'));
    expect(result.pass).toBe(true);
  });

  it('blocklist mode (not=true): fails when model is in the blocked list', () => {
    const blocklistRule = { ...allowlistRule, not: true };
    const result = runModelWhitelist(blocklistRule, ctx('', 'gpt-4o', 'beforeRequest'));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('blocked');
    expect(result.reason).toContain('gpt-4o');
  });

  it('treats missing model (ctx.model=undefined) as empty string — blocked by allowlist', () => {
    const result = runModelWhitelist(allowlistRule, ctx(''));
    expect(result.pass).toBe(false); // '' is not in ['gpt-4o', 'llama-3.3-70b']
  });

  it('treats missing model as NOT blocked by a blocklist', () => {
    const blocklistRule = { ...allowlistRule, not: true };
    const result = runModelWhitelist(blocklistRule, ctx(''));
    expect(result.pass).toBe(true); // '' is not in blocked list
  });

  it('exact-match only — no substring matching', () => {
    const result = runModelWhitelist(allowlistRule, ctx('', 'gpt-4o-mini', 'beforeRequest'));
    expect(result.pass).toBe(false); // 'gpt-4o-mini' != 'gpt-4o'
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// runContainsCode
// ══════════════════════════════════════════════════════════════════════════════

describe('runContainsCode', () => {
  describe('default mode (not=false) — block if code found', () => {
    it('passes when text has no code patterns', () => {
      const result = runContainsCode(
        { type: 'containsCode', hooks: ['afterResponse'] },
        ctx('The weather is nice today in Paris.'),
      );
      expect(result.pass).toBe(true);
    });

    it('fails when text contains Python code (2+ patterns)', () => {
      const result = runContainsCode(
        { type: 'containsCode', language: 'python', hooks: ['afterResponse'] },
        ctx('def greet(name):\n  print(f"Hello, {name}")'),
      );
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('python');
    });

    it('fails when text contains JavaScript code (2+ patterns)', () => {
      const result = runContainsCode(
        { type: 'containsCode', language: 'javascript', hooks: ['afterResponse'] },
        ctx('const greet = (name) => {\n  console.log("Hello " + name);\n}'),
      );
      expect(result.pass).toBe(false);
    });

    it('fails when text contains SQL code (2+ patterns)', () => {
      const result = runContainsCode(
        { type: 'containsCode', language: 'sql', hooks: ['afterResponse'] },
        ctx('SELECT * FROM users WHERE id = 1'),
      );
      expect(result.pass).toBe(false);
    });

    it('fails when text contains TypeScript code (2+ patterns)', () => {
      const result = runContainsCode(
        { type: 'containsCode', language: 'typescript', hooks: ['afterResponse'] },
        ctx('interface User { name: string }\ntype Role = string;'),
      );
      expect(result.pass).toBe(false);
    });

    it('fails when text contains HTML code (2+ patterns)', () => {
      const result = runContainsCode(
        { type: 'containsCode', language: 'html', hooks: ['afterResponse'] },
        ctx('<!DOCTYPE html>\n<div>Hello</div>'),
      );
      expect(result.pass).toBe(false);
    });

    it('language=any: fails on any single code pattern', () => {
      const result = runContainsCode(
        { type: 'containsCode', language: 'any', hooks: ['afterResponse'] },
        ctx('SELECT me from this table'),
      );
      expect(result.pass).toBe(false);
    });

    it('specific language: passes when only 1 pattern matches (below 2-pattern threshold)', () => {
      // "SELECT" alone matches 1 SQL pattern — not enough for 'sql' language
      const result = runContainsCode(
        { type: 'containsCode', language: 'sql', hooks: ['afterResponse'] },
        ctx('SELECT is a great word'),
      );
      expect(result.pass).toBe(true);
    });

    it('unknown language returns false (no patterns)', () => {
      const result = runContainsCode(
        { type: 'containsCode', language: 'cobol' as any, hooks: ['afterResponse'] },
        ctx('MOVE 1 TO COUNTER'),
      );
      expect(result.pass).toBe(true); // unknown language → no patterns → not detected
    });
  });

  describe('inverted mode (not=true) — require code to be present', () => {
    it('passes when text contains code', () => {
      const result = runContainsCode(
        { type: 'containsCode', language: 'python', not: true, hooks: ['afterResponse'] },
        ctx('def foo():\n  import os\n  print("hello")'),
      );
      expect(result.pass).toBe(true);
    });

    it('fails when text has no code (code is required)', () => {
      const result = runContainsCode(
        { type: 'containsCode', language: 'python', not: true, hooks: ['afterResponse'] },
        ctx('No code here, just plain text.'),
      );
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('does not contain expected');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// runJsonSchema
// ══════════════════════════════════════════════════════════════════════════════

describe('runJsonSchema', () => {
  const schemaRule = (schema: Record<string, unknown>, not = false) => ({
    type: 'jsonSchema' as const,
    schema,
    not,
    hooks: ['afterResponse' as const],
  });

  it('fails when text is not valid JSON', () => {
    const result = runJsonSchema(schemaRule({ type: 'object' }), ctx('not valid json{{{'));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('not valid JSON');
  });

  it('inverted (not=true): passes when text is not valid JSON', () => {
    const result = runJsonSchema(schemaRule({ type: 'object' }, true), ctx('not valid json{{{'));
    expect(result.pass).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('passes for valid object matching schema', () => {
    const result = runJsonSchema(
      schemaRule({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }),
      ctx(JSON.stringify({ name: 'Alice' })),
    );
    expect(result.pass).toBe(true);
  });

  it('fails when required field is missing', () => {
    const result = runJsonSchema(
      schemaRule({ type: 'object', required: ['name', 'age'] }),
      ctx(JSON.stringify({ name: 'Alice' })),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('age');
    expect(result.reason).toContain('required');
  });

  it('fails when type does not match', () => {
    const result = runJsonSchema(schemaRule({ type: 'object' }), ctx('"hello"'));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('must be object');
  });

  it('validates number minimum constraint', () => {
    const result = runJsonSchema(
      schemaRule({ type: 'number', minimum: 10 }),
      ctx('5'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('>= 10');
  });

  it('validates number maximum constraint', () => {
    const result = runJsonSchema(
      schemaRule({ type: 'number', maximum: 100 }),
      ctx('150'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('<= 100');
  });

  it('validates string minLength constraint', () => {
    const result = runJsonSchema(
      schemaRule({ type: 'string', minLength: 5 }),
      ctx('"hi"'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('at least 5 characters');
  });

  it('validates string maxLength constraint', () => {
    const result = runJsonSchema(
      schemaRule({ type: 'string', maxLength: 3 }),
      ctx('"toolong"'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('at most 3 characters');
  });

  it('validates enum constraint', () => {
    const result = runJsonSchema(
      schemaRule({ enum: ['a', 'b', 'c'] }),
      ctx('"d"'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('must be one of');
  });

  it('passes when value is in enum', () => {
    const result = runJsonSchema(
      schemaRule({ enum: ['a', 'b', 'c'] }),
      ctx('"b"'),
    );
    expect(result.pass).toBe(true);
  });

  it('validates nested object properties', () => {
    const result = runJsonSchema(
      schemaRule({
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: { age: { type: 'number', minimum: 0, maximum: 150 } },
          },
        },
      }),
      ctx(JSON.stringify({ user: { age: 200 } })),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('user.age');
  });

  it('validates array items', () => {
    const result = runJsonSchema(
      schemaRule({
        type: 'array',
        items: { type: 'number' },
      }),
      ctx('[1, 2, "three"]'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('must be number');
  });

  it('passes for valid array with typed items', () => {
    const result = runJsonSchema(
      schemaRule({ type: 'array', items: { type: 'string' } }),
      ctx('["a", "b", "c"]'),
    );
    expect(result.pass).toBe(true);
  });

  it('passes for null type', () => {
    const result = runJsonSchema(schemaRule({ type: 'null' }), ctx('null'));
    expect(result.pass).toBe(true);
  });

  it('fails when schema expects array but gets object', () => {
    const result = runJsonSchema(schemaRule({ type: 'array' }), ctx('{}'));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('must be array');
  });

  it('inverted (not=true): fails when response matches schema', () => {
    const result = runJsonSchema(
      schemaRule({ type: 'string' }, true),
      ctx('"valid string"'),
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('matched forbidden schema');
  });

  it('inverted (not=true): passes when response does not match schema', () => {
    const result = runJsonSchema(
      schemaRule({ type: 'string' }, true),
      ctx('42'),
    );
    expect(result.pass).toBe(true);
  });

  it('schema with no type constraint passes any JSON value', () => {
    const result = runJsonSchema(schemaRule({}), ctx('42'));
    expect(result.pass).toBe(true);
  });

  it('validates boolean type', () => {
    const resultTrue = runJsonSchema(schemaRule({ type: 'boolean' }), ctx('true'));
    expect(resultTrue.pass).toBe(true);

    const resultFalse = runJsonSchema(schemaRule({ type: 'boolean' }), ctx('false'));
    expect(resultFalse.pass).toBe(true);

    const resultNum = runJsonSchema(schemaRule({ type: 'boolean' }), ctx('1'));
    expect(resultNum.pass).toBe(false);
  });
});
