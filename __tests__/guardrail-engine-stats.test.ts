/**
 * GuardrailEngine + Stats integration tests
 *
 * Verifies that the engine correctly records stats to the global registry
 * when rules pass, block (action='block'), or audit (action='audit').
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GuardrailEngine } from '../src/gateway/guardrails';
import {
  getGuardrailStats,
  resetGuardrailStats,
} from '../src/gateway/guardrails/stats';
import type { GuardrailEngineConfig } from '../src/gateway/guardrails';

beforeEach(() => {
  resetGuardrailStats();
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEngine(config: GuardrailEngineConfig) {
  return new GuardrailEngine(config);
}

const msgBody = (content: string) => ({
  messages: [{ role: 'user', content }],
});

// ── pass path ─────────────────────────────────────────────────────────────────

describe('stats — pass path', () => {
  it('records a pass when all beforeRequest rules pass', async () => {
    const engine = makeEngine({
      rules: [{ type: 'notNull', hooks: ['beforeRequest'] }],
      action: 'block',
    });
    await engine.runBeforeRequest(msgBody('hello'));
    const s = getGuardrailStats();
    expect(s.passed).toBe(1);
    expect(s.blocked).toBe(0);
    expect(s.totalEvaluations).toBe(1);
  });

  it('records a pass when all afterResponse rules pass', async () => {
    const engine = makeEngine({
      rules: [{ type: 'notNull', hooks: ['afterResponse'] }],
      action: 'block',
    });
    await engine.runAfterResponseText('some response');
    const s = getGuardrailStats();
    expect(s.passed).toBe(1);
    expect(s.blocked).toBe(0);
  });

  it('records pass with empty rules', async () => {
    const engine = makeEngine({ rules: [] });
    await engine.runBeforeRequest(msgBody('anything'));
    // No rules → pass: true but we return early before recording
    // (engine returns early with pass: true when no rules)
    const s = getGuardrailStats();
    expect(s.totalEvaluations).toBe(0);
  });
});

// ── block path ────────────────────────────────────────────────────────────────

describe('stats — block path (action=block)', () => {
  it('records a block when beforeRequest regex rule fails', async () => {
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: 'forbidden', not: true, hooks: ['beforeRequest'] }],
      action: 'block',
    });
    await engine.runBeforeRequest(msgBody('contains forbidden word'));
    const s = getGuardrailStats();
    expect(s.blocked).toBe(1);
    expect(s.passed).toBe(0);
    expect(s.ruleHits['regex']).toBe(1);
    expect(s.lastBlockedAt).not.toBeNull();
  });

  it('records a block when afterResponse notNull fails', async () => {
    const engine = makeEngine({
      rules: [{ type: 'notNull', hooks: ['afterResponse'] }],
      action: 'block',
    });
    await engine.runAfterResponseText('');
    const s = getGuardrailStats();
    expect(s.blocked).toBe(1);
    expect(s.ruleHits['notNull']).toBe(1);
  });

  it('records a block when modelWhitelist rejects model', async () => {
    const engine = makeEngine({
      rules: [{ type: 'modelWhitelist', models: ['allowed-model'], hooks: ['beforeRequest'] }],
      action: 'block',
    });
    await engine.runBeforeRequest({}, 'forbidden-model');
    const s = getGuardrailStats();
    expect(s.blocked).toBe(1);
    expect(s.ruleHits['modelWhitelist']).toBe(1);
  });

  it('only records one block even when multiple rules exist (stops at first fail)', async () => {
    const engine = makeEngine({
      rules: [
        { type: 'notNull', hooks: ['beforeRequest'] },       // fails first (empty text)
        { type: 'regex', pattern: 'required', hooks: ['beforeRequest'] }, // never reached
      ],
      action: 'block',
    });
    await engine.runBeforeRequest(msgBody(''));
    const s = getGuardrailStats();
    expect(s.blocked).toBe(1);
    expect(s.ruleHits['notNull']).toBe(1);
    expect(s.ruleHits['regex']).toBeUndefined();
  });
});

// ── audit path ────────────────────────────────────────────────────────────────

describe('stats — audit path (action=audit)', () => {
  it('records audit (not block) when rule fails in audit mode', async () => {
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: 'secret', not: true, hooks: ['beforeRequest'] }],
      action: 'audit',
    });
    await engine.runBeforeRequest(msgBody('contains secret'));
    const s = getGuardrailStats();
    expect(s.audited).toBe(1);
    expect(s.blocked).toBe(0);
    expect(s.ruleHits['regex']).toBe(1);
    expect(s.lastBlockedAt).toBeNull(); // audit does not set lastBlockedAt
  });

  it('still records pass when rule passes in audit mode', async () => {
    const engine = makeEngine({
      rules: [{ type: 'notNull', hooks: ['afterResponse'] }],
      action: 'audit',
    });
    await engine.runAfterResponseText('valid response');
    const s = getGuardrailStats();
    expect(s.passed).toBe(1);
    expect(s.audited).toBe(0);
  });
});

// ── cumulative across multiple requests ───────────────────────────────────────

describe('cumulative stats across multiple requests', () => {
  it('accumulates correctly across many evaluations', async () => {
    const engine = makeEngine({
      rules: [{ type: 'regex', pattern: 'hello', hooks: ['beforeRequest'] }],
      action: 'block',
    });

    // 3 pass (contain "hello"), 2 block (don't contain "hello")
    await engine.runBeforeRequest(msgBody('hello world'));
    await engine.runBeforeRequest(msgBody('say hello'));
    await engine.runBeforeRequest(msgBody('hello'));
    await engine.runBeforeRequest(msgBody('goodbye'));   // block — no "hello"
    await engine.runBeforeRequest(msgBody('bye bye'));   // block — no "hello"

    const s = getGuardrailStats();
    expect(s.passed).toBe(3);
    expect(s.blocked).toBe(2);
    expect(s.totalEvaluations).toBe(5);
    expect(s.ruleHits['regex']).toBe(2);
  });

  it('accumulates across both beforeRequest and afterResponse hooks', async () => {
    const engine = makeEngine({
      rules: [
        { type: 'notNull', hooks: ['beforeRequest'] },
        { type: 'notNull', hooks: ['afterResponse'] },
      ],
      action: 'block',
    });

    await engine.runBeforeRequest(msgBody('valid'));    // pass
    await engine.runBeforeRequest(msgBody(''));         // block
    await engine.runAfterResponseText('response');     // pass
    await engine.runAfterResponseText('');             // block

    const s = getGuardrailStats();
    expect(s.passed).toBe(2);
    expect(s.blocked).toBe(2);
    expect(s.totalEvaluations).toBe(4);
  });
});

// ── different rule types each record their own hits ───────────────────────────

describe('ruleHits tracks each rule type separately', () => {
  it('correctly separates hit counts per rule type', async () => {
    const block1 = makeEngine({ rules: [{ type: 'regex', pattern: 'bad', not: true, hooks: ['beforeRequest'] }], action: 'block' });
    const block2 = makeEngine({ rules: [{ type: 'jsonSchema', schema: { type: 'object', required: ['name'] }, hooks: ['afterResponse'] }], action: 'block' });

    await block1.runBeforeRequest(msgBody('bad content'));     // regex block
    await block1.runBeforeRequest(msgBody('bad again'));       // regex block
    await block2.runAfterResponseText('not json');             // jsonSchema block

    const s = getGuardrailStats();
    expect(s.ruleHits['regex']).toBe(2);
    expect(s.ruleHits['jsonSchema']).toBe(1);
    expect(s.blocked).toBe(3);
  });
});
