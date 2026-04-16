/**
 * Rule-based guardrails — unit tests
 *
 * Tests all rule types and the GuardrailEngine integration with the
 * chat-completions handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuardrailEngine, extractRequestText, extractResponseText } from '../src/gateway/guardrails';
import type { GuardrailEngineConfig } from '../src/gateway/guardrails';
import { handleChatCompletions } from '../src/gateway/proxy/routes/chat-completions';
import type { ProxyRequest } from '../src/gateway/proxy/types';
import type { LLMProvider } from '../src/providers';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): ProxyRequest {
  return {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {},
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

function makeMockProvider(content = 'Hello, world!'): LLMProvider {
  return {
    providerId: 'mock',
    getModels: () => [],
    isConfigured: () => true,
    chat: vi.fn().mockResolvedValue({
      content,
      model: 'mock-model',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
  };
}

function makeEngine(config: GuardrailEngineConfig) {
  return new GuardrailEngine(config);
}

// ── extractRequestText ────────────────────────────────────────────────────────

describe('extractRequestText', () => {
  it('returns empty string for non-objects', () => {
    expect(extractRequestText(null)).toBe('');
    expect(extractRequestText(42)).toBe('');
  });

  it('extracts text from OpenAI messages array', () => {
    const body = { messages: [{ role: 'user', content: 'Hello' }, { role: 'user', content: 'World' }] };
    expect(extractRequestText(body)).toBe('Hello\nWorld');
  });

  it('extracts text from prompt field', () => {
    expect(extractRequestText({ prompt: 'test prompt' })).toBe('test prompt');
  });

  it('returns string as-is', () => {
    expect(extractRequestText('raw text')).toBe('raw text');
  });
});

// ── extractResponseText ───────────────────────────────────────────────────────

describe('extractResponseText', () => {
  it('extracts from OpenAI choices array', () => {
    const body = { choices: [{ message: { content: 'response text' } }] };
    expect(extractResponseText(body)).toBe('response text');
  });

  it('extracts from text field', () => {
    expect(extractResponseText({ text: 'plain text' })).toBe('plain text');
  });

  it('extracts from content field', () => {
    expect(extractResponseText({ content: 'content text' })).toBe('content text');
  });

  it('parses JSON string', () => {
    const body = JSON.stringify({ choices: [{ message: { content: 'parsed' } }] });
    expect(extractResponseText(body)).toBe('parsed');
  });
});

// ── regex rule ────────────────────────────────────────────────────────────────

describe('regex rule', () => {
  it('passes when text matches pattern', async () => {
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: 'hello', hooks: ['beforeRequest'] }],
    });
    const result = await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'hello world' }] });
    expect(result.pass).toBe(true);
  });

  it('blocks when text does not match pattern', async () => {
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: 'hello', hooks: ['beforeRequest'] }],
    });
    const result = await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'goodbye world' }] });
    expect(result.pass).toBe(false);
    expect(result.failedRule).toBe('regex');
    expect(result.reason).toContain('hello');
  });

  it('inverts with not=true (blocklist mode)', async () => {
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: 'badword', not: true, hooks: ['beforeRequest'] }],
    });
    const passResult = await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'nice text' }] });
    expect(passResult.pass).toBe(true);

    const blockResult = await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'contains badword here' }] });
    expect(blockResult.pass).toBe(false);
  });

  it('is case insensitive', async () => {
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: 'HELLO', hooks: ['beforeRequest'] }],
    });
    const result = await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'hello' }] });
    expect(result.pass).toBe(true);
  });

  it('returns fail with invalid regex', async () => {
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: '[invalid(', hooks: ['beforeRequest'] }],
    });
    const result = await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'text' }] });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('Invalid regex pattern');
  });

  it('skips rule if hook does not match', async () => {
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: 'hello', hooks: ['afterResponse'] }],
    });
    // Rule only applies to afterResponse — beforeRequest should pass
    const result = await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'goodbye' }] });
    expect(result.pass).toBe(true);
  });
});

// ── jsonSchema rule ───────────────────────────────────────────────────────────

describe('jsonSchema rule', () => {
  it('passes when response matches schema', async () => {
    const engine = makeEngine({
      rules: [{
        type: 'jsonSchema',
        schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        hooks: ['afterResponse'],
      }],
    });
    const result = await engine.runAfterResponseText(JSON.stringify({ name: 'Alice' }));
    expect(result.pass).toBe(true);
  });

  it('blocks when response does not match schema', async () => {
    const engine = makeEngine({
      rules: [{
        type: 'jsonSchema',
        schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        hooks: ['afterResponse'],
      }],
    });
    const result = await engine.runAfterResponseText(JSON.stringify({ age: 30 }));
    expect(result.pass).toBe(false);
    expect(result.failedRule).toBe('jsonSchema');
    expect(result.reason).toContain('name is required');
  });

  it('blocks when response is not valid JSON', async () => {
    const engine = makeEngine({
      rules: [{
        type: 'jsonSchema',
        schema: { type: 'object' },
        hooks: ['afterResponse'],
      }],
    });
    const result = await engine.runAfterResponseText('not json');
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('not valid JSON');
  });

  it('validates nested properties', async () => {
    const engine = makeEngine({
      rules: [{
        type: 'jsonSchema',
        schema: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              required: ['email'],
              properties: { email: { type: 'string', minLength: 5 } },
            },
          },
        },
        hooks: ['afterResponse'],
      }],
    });

    const passResult = await engine.runAfterResponseText(JSON.stringify({ user: { email: 'a@b.com' } }));
    expect(passResult.pass).toBe(true);

    const failResult = await engine.runAfterResponseText(JSON.stringify({ user: { email: 'ab' } }));
    expect(failResult.pass).toBe(false);
    expect(failResult.reason).toContain('at least 5 characters');
  });

  it('validates enum values', async () => {
    const engine = makeEngine({
      rules: [{
        type: 'jsonSchema',
        schema: { type: 'object', properties: { status: { enum: ['ok', 'error'] } } },
        hooks: ['afterResponse'],
      }],
    });
    const failResult = await engine.runAfterResponseText(JSON.stringify({ status: 'unknown' }));
    expect(failResult.pass).toBe(false);
    expect(failResult.reason).toContain('one of');
  });
});

// ── containsCode rule ─────────────────────────────────────────────────────────

describe('containsCode rule', () => {
  it('passes by default when no code present', async () => {
    const engine = makeEngine({
      rules: [{ type: 'containsCode', hooks: ['afterResponse'] }],
    });
    const result = await engine.runAfterResponseText('The weather today is sunny and warm.');
    expect(result.pass).toBe(true);
  });

  it('blocks when code is detected (any language)', async () => {
    const engine = makeEngine({
      rules: [{ type: 'containsCode', hooks: ['afterResponse'] }],
    });
    const result = await engine.runAfterResponseText(
      'Here is the code:\nSELECT * FROM users WHERE id = 1;\nFROM orders JOIN users',
    );
    expect(result.pass).toBe(false);
    expect(result.failedRule).toBe('containsCode');
  });

  it('detects Python specifically', async () => {
    const engine = makeEngine({
      rules: [{ type: 'containsCode', language: 'python', hooks: ['afterResponse'] }],
    });
    const result = await engine.runAfterResponseText(
      'def greet(name):\n    print(f"Hello {name}")\nimport os',
    );
    expect(result.pass).toBe(false);
  });

  it('inverted: requires code to be present', async () => {
    const engine = makeEngine({
      rules: [{ type: 'containsCode', language: 'sql', not: true, hooks: ['afterResponse'] }],
    });
    const noCodeResult = await engine.runAfterResponseText('Plain text response');
    expect(noCodeResult.pass).toBe(false);
    expect(noCodeResult.reason).toContain('does not contain expected');

    const codeResult = await engine.runAfterResponseText(
      'SELECT id FROM users WHERE active = 1;\nFROM orders',
    );
    expect(codeResult.pass).toBe(true);
  });
});

// ── notNull rule ──────────────────────────────────────────────────────────────

describe('notNull rule', () => {
  it('passes when text is non-empty', async () => {
    const engine = makeEngine({
      rules: [{ type: 'notNull', hooks: ['afterResponse'] }],
    });
    const result = await engine.runAfterResponseText('some content');
    expect(result.pass).toBe(true);
  });

  it('blocks when text is empty', async () => {
    const engine = makeEngine({
      rules: [{ type: 'notNull', hooks: ['afterResponse'] }],
    });
    const result = await engine.runAfterResponseText('');
    expect(result.pass).toBe(false);
    expect(result.failedRule).toBe('notNull');
    expect(result.reason).toContain('empty or null');
  });

  it('blocks when text is only whitespace', async () => {
    const engine = makeEngine({
      rules: [{ type: 'notNull', hooks: ['afterResponse'] }],
    });
    const result = await engine.runAfterResponseText('   \n  ');
    expect(result.pass).toBe(false);
  });

  it('inverted: passes when text is empty', async () => {
    const engine = makeEngine({
      rules: [{ type: 'notNull', not: true, hooks: ['afterResponse'] }],
    });
    const result = await engine.runAfterResponseText('');
    expect(result.pass).toBe(true);
  });
});

// ── modelWhitelist rule ───────────────────────────────────────────────────────

describe('modelWhitelist rule', () => {
  it('passes when model is in the list', async () => {
    const engine = makeEngine({
      rules: [{ type: 'modelWhitelist', models: ['gpt-4o', 'llama-3.3-70b'], hooks: ['beforeRequest'] }],
    });
    const result = await engine.runBeforeRequest({}, 'gpt-4o');
    expect(result.pass).toBe(true);
  });

  it('blocks when model is not in the list', async () => {
    const engine = makeEngine({
      rules: [{ type: 'modelWhitelist', models: ['gpt-4o'], hooks: ['beforeRequest'] }],
    });
    const result = await engine.runBeforeRequest({}, 'claude-3-opus');
    expect(result.pass).toBe(false);
    expect(result.failedRule).toBe('modelWhitelist');
    expect(result.reason).toContain('allowed list');
  });

  it('blocklist mode (not=true): blocks model in list', async () => {
    const engine = makeEngine({
      rules: [{ type: 'modelWhitelist', models: ['banned-model'], not: true, hooks: ['beforeRequest'] }],
    });
    const blockResult = await engine.runBeforeRequest({}, 'banned-model');
    expect(blockResult.pass).toBe(false);
    expect(blockResult.reason).toContain('is blocked');

    const passResult = await engine.runBeforeRequest({}, 'allowed-model');
    expect(passResult.pass).toBe(true);
  });
});

// ── multiple rules ─────────────────────────────────────────────────────────────

describe('multiple rules — stops at first failure', () => {
  it('stops at first failing rule', async () => {
    const engine = makeEngine({
      rules: [
        { type: 'notNull', hooks: ['afterResponse'] },
        { type: 'regex', pattern: 'required', hooks: ['afterResponse'] },
      ],
    });
    // empty text → notNull fails first
    const result = await engine.runAfterResponseText('');
    expect(result.pass).toBe(false);
    expect(result.failedRule).toBe('notNull');
  });

  it('passes when all rules pass', async () => {
    const engine = makeEngine({
      rules: [
        { type: 'notNull', hooks: ['afterResponse'] },
        { type: 'regex', pattern: 'hello', hooks: ['afterResponse'] },
      ],
    });
    const result = await engine.runAfterResponseText('hello world');
    expect(result.pass).toBe(true);
  });

  it('passes with no rules', async () => {
    const engine = makeEngine({ rules: [] });
    expect((await engine.runBeforeRequest({})).pass).toBe(true);
    expect((await engine.runAfterResponse({})).pass).toBe(true);
  });
});

// ── GuardrailEngine + handleChatCompletions integration ───────────────────────

describe('handleChatCompletions + guardrails integration', () => {
  const baseBody = {
    model: 'mock-model',
    messages: [{ role: 'user', content: 'hello world' }],
  };

  it('blocks request when beforeRequest rule fails (action=block)', async () => {
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: 'BLOCKED_WORD', hooks: ['beforeRequest'] }],
      action: 'block',
    });

    const req = makeRequest({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'contains BLOCKED_WORD here' }],
    });

    // With not=false (default) and pattern=BLOCKED_WORD: passes when text contains the pattern
    // This ALLOWS requests with BLOCKED_WORD. To block, use not=true.
    // Re-create with not=true (blocklist):
    const blockEngine = makeEngine({
      rules: [{ type: 'regex', pattern: 'BLOCKED_WORD', not: true, hooks: ['beforeRequest'] }],
      action: 'block',
    });

    const result = await handleChatCompletions(
      req,
      { 'mock-model': makeMockProvider() },
      undefined,
      undefined,
      undefined,
      blockEngine,
    );

    expect(result.status).toBe(400);
    const body = result.body as { error: { message: string } };
    expect(body.error.message).toContain('BLOCKED_WORD');
  });

  it('passes request through when beforeRequest rules pass', async () => {
    const engine = makeEngine({
      rules: [{ type: 'notNull', hooks: ['beforeRequest'] }],
      action: 'block',
    });

    const req = makeRequest(baseBody);
    const result = await handleChatCompletions(
      req,
      { 'mock-model': makeMockProvider('Hello back!') },
      undefined,
      undefined,
      undefined,
      engine,
    );

    expect(result.status).toBe(200);
    const body = result.body as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('Hello back!');
  });

  it('blocks response when afterResponse rule fails (action=block)', async () => {
    // jsonSchema rule: response must have a "name" field
    const engine = makeEngine({
      rules: [{
        type: 'jsonSchema',
        schema: { type: 'object', required: ['name'] },
        hooks: ['afterResponse'],
      }],
      action: 'block',
    });

    const req = makeRequest(baseBody);
    // Provider returns plain text, not JSON with "name"
    const result = await handleChatCompletions(
      req,
      { 'mock-model': makeMockProvider('Hello, world!') },
      undefined,
      undefined,
      undefined,
      engine,
    );

    expect(result.status).toBe(400);
    const body = result.body as { error: { message: string } };
    expect(body.error.message).toContain('JSON');
  });

  it('audit mode — logs but does not block', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: 'BLOCKED', not: true, hooks: ['beforeRequest'] }],
      action: 'audit',
    });

    const req = makeRequest({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'BLOCKED content' }],
    });

    const result = await handleChatCompletions(
      req,
      { 'mock-model': makeMockProvider('Response') },
      undefined,
      undefined,
      undefined,
      engine,
    );

    // audit mode — request goes through despite rule failure
    expect(result.status).toBe(200);
    warnSpy.mockRestore();
  });

  it('no guardrails — handler works normally', async () => {
    const req = makeRequest(baseBody);
    const result = await handleChatCompletions(
      req,
      { 'mock-model': makeMockProvider('Normal response') },
    );
    expect(result.status).toBe(200);
  });

  it('modelWhitelist blocks unknown model in beforeRequest', async () => {
    const engine = makeEngine({
      rules: [{ type: 'modelWhitelist', models: ['allowed-model'], hooks: ['beforeRequest'] }],
      action: 'block',
    });

    const req = makeRequest({
      model: 'forbidden-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const result = await handleChatCompletions(
      req,
      { 'forbidden-model': makeMockProvider() },
      undefined,
      undefined,
      undefined,
      engine,
    );

    expect(result.status).toBe(400);
    const body = result.body as { error: { message: string } };
    expect(body.error.message).toContain('allowed list');
  });
});
