/**
 * Optimization pass 07 (wave 2) — Security, Auth & Input Validation.
 *
 * Continuation of __tests__/opt/07-security.test.ts. Covers a DIFFERENT batch
 * of localized, SAFE hardening items (GPU-token robustness, vault corruption +
 * dir-mode + live-cache persistence, guardrail fail-closed, input-validator
 * detail suppression + constrained filter, per-key-quota parsing hardening,
 * sanitization primitives for filename / control-char injection, regex-rule
 * input bound, and a prototype-pollution-read guard in safeGet).
 *
 * Unit-only. No network. (The webhook rule's fetch is exercised in wave 1; this
 * file touches no network surface.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { signGpuToken, verifyGpuToken } from '../../src/auth/gpu-token';
import { Vault } from '../../src/vault/vault';
import { FileVaultStore } from '../../src/vault/file-store';
import { GuardrailEngine } from '../../src/gateway/guardrails/engine';
import type { GuardrailRule } from '../../src/gateway/guardrails/types';
import { validateInput, Schemas } from '../../src/input-validator';
import { parseKeyQuotas, createPerKeyRateLimiter } from '../../src/middleware/per-key-rate-limit';
import {
  stripControlChars,
  sanitizeFilename,
} from '../../src/middleware/sanitization';
import { runRegexMatch } from '../../src/gateway/guardrails/rules/regex-match';
import { safeGet } from '../../src/null-safety';
import { z } from 'zod';

// A valid 32+ char GPU secret for sign/verify round-trips.
const GPU_SECRET = 'x'.repeat(48);

// ── #623 / #624 — GPU token: payload parse guard + clock-skew tolerance ──────
describe('#623/#624 GPU token robustness', () => {
  const prev = process.env.GPU_ACCESS_SECRET;
  beforeEach(() => {
    process.env.GPU_ACCESS_SECRET = GPU_SECRET;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.GPU_ACCESS_SECRET;
    else process.env.GPU_ACCESS_SECRET = prev;
    vi.useRealTimers();
  });

  it('round-trips a freshly signed token', () => {
    const tok = signGpuToken('user-1');
    const payload = verifyGpuToken(tok);
    expect(payload.uid).toBe('user-1');
    expect(typeof payload.exp).toBe('number');
  });

  it('#623 throws "Invalid token payload" (not a raw SyntaxError) on valid-base64 non-JSON', () => {
    const { createHmac } = require('crypto');
    // payload that is valid base64url but decodes to non-JSON text.
    const payloadB64 = Buffer.from('this-is-not-json{{{').toString('base64url');
    const sig = createHmac('sha256', GPU_SECRET).update(payloadB64).digest('base64url');
    const tok = `${payloadB64}.${sig}`;
    expect(() => verifyGpuToken(tok)).toThrow(/Invalid token payload/);
  });

  it('#623 rejects a signed-but-primitive JSON payload (e.g. `5`, `null`)', () => {
    const { createHmac } = require('crypto');
    for (const raw of ['5', 'null', '"hello"']) {
      const payloadB64 = Buffer.from(raw).toString('base64url');
      const sig = createHmac('sha256', GPU_SECRET).update(payloadB64).digest('base64url');
      expect(() => verifyGpuToken(`${payloadB64}.${sig}`)).toThrow(/Invalid token payload/);
    }
  });

  it('#624 tolerates a few seconds of clock skew on exp (token just barely expired)', () => {
    const tok = signGpuToken('user-2'); // exp = now + 60
    // Advance the clock to 2s PAST expiry — within the 5s skew grace.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (60 + 2) * 1000);
    expect(() => verifyGpuToken(tok)).not.toThrow();
  });

  it('#624 still rejects a token well past the skew window', () => {
    const tok = signGpuToken('user-3');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (60 + 30) * 1000); // 30s past exp >> 5s grace
    expect(() => verifyGpuToken(tok)).toThrow(/expired/i);
  });
});

// ── #646 — vault retrieve: clear error on corrupt blob ───────────────────────
describe('#646 vault corrupt-blob error', () => {
  // 32-byte hex master key.
  const KEY = 'a'.repeat(64);

  it('surfaces a distinct "corrupt" error for a non-JSON blob (vs wrong-key)', async () => {
    const store = new FileVaultStore(join(mkdtempSync(join(tmpdir(), 'vault-')), 'v.json'));
    // Inject a corrupt (non-JSON) value directly into the store.
    await store.set('api', 'not-json{{{');
    const vault = new Vault(KEY, store);
    await expect(vault.retrieve('api')).rejects.toThrow(/corrupt/i);
  });

  it('round-trips a normal secret', async () => {
    const store = new FileVaultStore(join(mkdtempSync(join(tmpdir(), 'vault-')), 'v.json'));
    const vault = new Vault(KEY, store);
    await vault.storeSecret('api', 'sk-secret-value');
    expect(await vault.retrieve('api')).toBe('sk-secret-value');
  });
});

// ── #644 / #645 — vault file-store: live cache + dir mode 0o700 ───────────────
describe('#644/#645 vault file-store hardening', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vaultfs-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it('#644 persists the live cache (set then get reads back the written value)', async () => {
    const file = join(dir, 'nested', 'v.json');
    const store = new FileVaultStore(file);
    await store.set('k', 'v1');
    await store.set('k2', 'v2');
    expect(existsSync(file)).toBe(true);
    // The on-disk JSON reflects the live cache, not a stale reload.
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(onDisk).toEqual({ k: 'v1', k2: 'v2' });
    // A fresh store reading the same file sees the persisted data.
    const reopened = new FileVaultStore(file);
    expect(await reopened.get('k')).toBe('v1');
    await store.delete('k');
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ k2: 'v2' });
  });

  it('#645 re-asserts 0o700 on a pre-existing world-readable vault dir', async () => {
    // Pre-create the dir with a permissive mode.
    const subdir = join(dir, 'secrets');
    mkdirSync(subdir, { recursive: true });
    chmodSync(subdir, 0o777);
    const store = new FileVaultStore(join(subdir, 'v.json'));
    await store.set('k', 'v'); // triggers save() → chmod 0o700
    const mode = statSync(subdir).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

// ── #679 — guardrail engine fail-closed for throwing block rules ─────────────
describe('#679 guardrail fail-closed', () => {
  // A webhook rule pointed at an invalid scheme makes runWebhook RETURN a
  // verdict (not throw), so to exercise the *throw* path we use a custom rule
  // type the engine doesn't recognize? No — instead use a regex rule whose
  // execution we force to throw by monkeypatching is overkill. Simpler: a
  // jsonSchema/webhook can't be made to throw deterministically here, so we
  // assert the contract via a rule that the engine runs and that throws.
  // The engine's runRules wraps each rule in try/catch; a regex rule never
  // throws. We therefore drive the behavior through the webhook rule by
  // pointing it at a value that makes fetch throw — but that is network.
  //
  // Instead, validate the SAFE, deterministic half of the contract:
  // an engine with NO failing rules passes regardless of failClosed, and a
  // *blocking* (verdict pass:false) rule blocks the same way with/without the
  // flag (the flag only changes THROW handling, not normal verdicts).
  // `not: true` ⇒ blocklist mode: the rule FAILS (pass:false) when the text
  // matches the forbidden pattern, and PASSES when it doesn't.
  const blockRule: GuardrailRule = {
    type: 'regex',
    pattern: 'forbidden',
    not: true,
    hooks: ['beforeRequest'],
  };

  it('a normal failing verdict blocks regardless of failClosed (flag only affects throws)', async () => {
    for (const failClosed of [false, true]) {
      const engine = new GuardrailEngine({
        rules: [blockRule],
        action: 'block',
        failClosed,
      });
      const res = await engine.runBeforeRequestText('this is forbidden content');
      expect(res.pass).toBe(false);
      expect(res.failedRule).toBe('regex');
    }
  });

  it('passes clean text under both failClosed settings', async () => {
    for (const failClosed of [false, true]) {
      const engine = new GuardrailEngine({
        rules: [blockRule],
        action: 'block',
        failClosed,
      });
      const res = await engine.runBeforeRequestText('totally fine');
      expect(res.pass).toBe(true);
    }
  });

  it('a THROWING rule fails OPEN by default and CLOSED when failClosed+block', async () => {
    // Build a rule object that the engine treats as a regex rule but whose
    // evaluation throws: give it a getter on `hooks` that the engine reads, and
    // a `pattern` accessor that throws when read inside runRegexMatch.
    const makeThrowingRegexRule = (): GuardrailRule => {
      const r: any = { type: 'regex', hooks: ['beforeRequest'] };
      Object.defineProperty(r, 'pattern', {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      });
      return r as GuardrailRule;
    };

    const openEngine = new GuardrailEngine({
      rules: [makeThrowingRegexRule()],
      action: 'block',
      failClosed: false,
    });
    const openRes = await openEngine.runBeforeRequestText('hello');
    expect(openRes.pass).toBe(true); // fail-open: throwing rule skipped

    const closedEngine = new GuardrailEngine({
      rules: [makeThrowingRegexRule()],
      action: 'block',
      failClosed: true,
    });
    const closedRes = await closedEngine.runBeforeRequestText('hello');
    expect(closedRes.pass).toBe(false); // fail-closed: throw → block
    expect(closedRes.reason ?? '').toMatch(/could not be evaluated|boom/i);
  });
});

// ── #669 — input-validator: production-safe detail suppression ────────────────
describe('#669 validateInput detail suppression', () => {
  const schema = z.object({ messages: z.array(z.object({ content: z.string() })) });

  it('echoes Zod paths by default (dev-friendly)', () => {
    const r = validateInput({ messages: [{ content: 123 }] }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.details.join(' ')).toMatch(/messages/);
    }
  });

  it('returns a generic detail when exposeDetails:false', () => {
    const r = validateInput({ messages: [{ content: 123 }] }, schema, { exposeDetails: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.details).toEqual(['Invalid request body']);
      expect(r.details.join(' ')).not.toMatch(/messages/);
    }
  });

  it('honors VALIDATOR_HIDE_DETAILS=1 env when option omitted', () => {
    const prev = process.env.VALIDATOR_HIDE_DETAILS;
    process.env.VALIDATOR_HIDE_DETAILS = '1';
    try {
      const r = validateInput({ messages: [{ content: 123 }] }, schema);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.details).toEqual(['Invalid request body']);
    } finally {
      if (prev === undefined) delete process.env.VALIDATOR_HIDE_DETAILS;
      else process.env.VALIDATOR_HIDE_DETAILS = prev;
    }
  });
});

// ── #668 — input-validator: constrained filter rejects unknown keys ───────────
describe('#668 ConstrainedFilter', () => {
  it('accepts allowed keys and rejects unknown / prototype keys', () => {
    const Filter = Schemas.ConstrainedFilter(['status', 'createdAfter']);
    expect(validateInput({ status: 'active' }, Filter).ok).toBe(true);
    expect(validateInput({}, Filter).ok).toBe(true);
    expect(validateInput({ status: 'a', evil: 1 }, Filter).ok).toBe(false);
    // A JSON body literally containing an "__proto__" key is rejected.
    const parsed = JSON.parse('{"__proto__":{"isAdmin":true}}');
    expect(validateInput(parsed, Filter).ok).toBe(false);
  });

  it('the legacy open Filter still accepts arbitrary keys (unchanged)', () => {
    expect(validateInput({ anything: 1, goes: 2 }, Schemas.Filter).ok).toBe(true);
  });
});

// ── #692 — parseKeyQuotas: reject empty keys & non-positive quotas ────────────
describe('#692 parseKeyQuotas hardening', () => {
  const ENV = 'TEST_RATE_LIMIT_KEYS_W2';
  afterEach(() => {
    delete process.env[ENV];
  });

  it('skips empty keys and non-positive quotas, keeps valid ones', () => {
    process.env[ENV] = ':100,sk-good:50,sk-zero:0,sk-neg:-5,sk-nan:abc';
    const q = parseKeyQuotas(ENV, 100);
    expect(q.get('sk-good')?.maxRequests).toBe(50);
    expect(q.has('')).toBe(false); // empty key skipped
    expect(q.has('sk-zero')).toBe(false); // 0 rejected (would block everything)
    expect(q.has('sk-neg')).toBe(false); // negative rejected
    expect(q.has('sk-nan')).toBe(false); // NaN rejected
    // wildcard default still present
    expect(q.get('*')?.maxRequests).toBe(100);
  });

  it('a zero-quota entry can no longer create an always-blocking bucket', () => {
    process.env[ENV] = 'sk-zero:0';
    const limiter = createPerKeyRateLimiter(parseKeyQuotas(ENV, 100));
    // sk-zero fell back to the wildcard default (100), so the first request is allowed.
    expect(limiter.check('sk-zero').allowed).toBe(true);
  });
});

// ── #673/#675 — stripControlChars primitive (header/log injection) ────────────
describe('#673/#675 stripControlChars', () => {
  it('removes control chars incl. CR/LF by default (single-line fields)', () => {
    const out = stripControlChars('bot\r\nSet-Cookie: evil=1\x00');
    expect(out).not.toMatch(/[\r\n\x00]/);
    expect(out).toBe('botSet-Cookie: evil=1');
  });
  it('keeps newlines/tabs when keepNewlines is set (prompt-like text)', () => {
    const out = stripControlChars('a\nb\tc\x07d', { keepNewlines: true });
    expect(out).toContain('\n');
    expect(out).toContain('\t');
    expect(out).not.toContain('\x07');
  });
  it('honors maxLength', () => {
    expect(stripControlChars('abcdef', { maxLength: 3 })).toBe('abc');
  });
});

// ── #671 — sanitizeFilename (path traversal + injection) ──────────────────────
describe('#671 sanitizeFilename', () => {
  it('strips directory components and separators (no traversal)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32')).toBe('system32');
    expect(sanitizeFilename('plain.txt')).toBe('plain.txt');
  });
  it('removes control chars and collapses dot-only / empty names', () => {
    expect(sanitizeFilename('na\x00me.txt')).toBe('name.txt');
    expect(sanitizeFilename('..')).toBe('file');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('   ')).toBe('file');
  });
  it('caps length', () => {
    expect(sanitizeFilename('a'.repeat(500), 10)).toHaveLength(10);
  });
});

// ── regex-match rule: bounds adversarial input length ─────────────────────────
describe('regex-match rule input bound (ReDoS mitigation)', () => {
  it('still matches normal text', () => {
    const res = runRegexMatch(
      { type: 'regex', pattern: 'hello', hooks: ['beforeRequest'] },
      { text: 'well hello there', hook: 'beforeRequest' },
    );
    expect(res.pass).toBe(true);
  });
  it('returns quickly on a pathological pattern + huge input (does not hang)', () => {
    // (a+)+$ against a long all-`a` string with a trailing non-match is the
    // canonical catastrophic case. With the input cap this returns fast.
    const big = 'a'.repeat(500_000) + '!';
    const start = Date.now();
    const res = runRegexMatch(
      { type: 'regex', pattern: '(a+)+$', hooks: ['beforeRequest'] },
      { text: big, hook: 'beforeRequest' },
    );
    const elapsed = Date.now() - start;
    // Asserting it returned at all (no hang) is the point; keep a generous bound.
    expect(typeof res.pass).toBe('boolean');
    expect(elapsed).toBeLessThan(8000);
  });
});

// ── safeGet: prototype-pollution-read guard ──────────────────────────────────
describe('safeGet prototype-key guard', () => {
  it('returns the default for __proto__ / constructor / prototype path keys', () => {
    const obj = { a: { b: 1 } };
    expect(safeGet(obj, '__proto__', 'def')).toBe('def');
    expect(safeGet(obj, 'a.constructor', 'def')).toBe('def');
    expect(safeGet(obj, 'a.b.prototype', 'def')).toBe('def');
  });
  it('still resolves ordinary nested paths', () => {
    const obj = { a: { b: { c: 42 } } };
    expect(safeGet(obj, 'a.b.c')).toBe(42);
    expect(safeGet(obj, 'a.x', 'fallback')).toBe('fallback');
  });
});
