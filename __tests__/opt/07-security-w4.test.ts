/**
 * Optimization pass 07 (wave 4) — Security, Auth & Input Validation.
 *
 * Continuation of waves 1–3 (`07-security.test.ts`, `-w2`, `-w3`). Covers a NEW
 * batch of localized, SAFE hardening items. As in prior waves: primitives only —
 * NO previously-dead middleware (RBAC / CSRF / rate-limiter / DLP) is wired into
 * the live server path, NO GPU-token wire format is changed (sign still uses the
 * current secret; only verify gains an optional second key), and NO vault
 * on-disk blob format is changed.
 *
 *  - #604      sanitization: constantTimeEqual (length-independent compare)
 *  - #650/#696 sanitization: redactSecrets (consistent masking in logs)
 *  - #619      gpu-token: GPU_ACCESS_SECRET_PREVIOUS verify (rotation overlap)
 *  - #650      vault: onAccess audit hook (metadata only, never the value)
 *  - #646-ext  vault: blob field-shape validation (corrupt vs wrong-key)
 *  - #647      vault-singleton: initAndScrubVaultFromEnv convenience
 *  - #698      security-headers: buildContentSecurityPolicy nonce primitive
 *  - #686      per-key-rate-limit: cost-weighted check({ cost })
 *  - #664      input-validator: clampNumber
 *  - #662/#663 input-validator: Schemas.BoundedString / BoundedArray
 *  - guardrails contains-code: 'any' mode requires >=2 hits in one language
 *  - guardrails regex rule: pattern-length cap
 *  - #685      guardrails: coerceGuardrailAction (unknown action → fail-closed)
 *  - csrf: nonce min-length structural guard
 *  - null-safety: safeParseInt strict mode for arbitrary radix
 *  - #612      auth-middleware: isDevBypassActive predicate
 *
 * Unit-only. No network surface is touched (no fetch is invoked).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  constantTimeEqual,
  redactSecrets,
  maskApiKey,
} from '../../src/middleware/sanitization';
import { signGpuToken, verifyGpuToken } from '../../src/auth/gpu-token';
import { Vault, type VaultAccessEvent } from '../../src/vault/vault';
import { FileVaultStore } from '../../src/vault/file-store';
import type { VaultStore } from '../../src/vault/types';
import {
  initAndScrubVaultFromEnv,
  getVault,
  resetVault,
} from '../../src/vault/vault-singleton';
import {
  buildContentSecurityPolicy,
  applySecurityHeaders,
  SECURITY_HEADERS,
} from '../../src/middleware/security-headers';
import { createPerKeyRateLimiter } from '../../src/middleware/per-key-rate-limit';
import { clampNumber, Schemas, validateInput } from '../../src/input-validator';
import { runContainsCode } from '../../src/gateway/guardrails/rules/contains-code';
import { runRegexMatch } from '../../src/gateway/guardrails/rules/regex-match';
import { coerceGuardrailAction } from '../../src/gateway/guardrails/config-validation';
import { verifyCsrfToken, generateCsrfToken } from '../../src/middleware/csrf';
import { safeParseInt } from '../../src/null-safety';
import { isDevBypassActive } from '../../src/auth-middleware';

const KEY_HEX = 'a'.repeat(64); // 32-byte hex master key

// ── #604 — constantTimeEqual ──────────────────────────────────────────────────
describe('#604 constantTimeEqual', () => {
  it('returns true only for byte-identical strings', () => {
    expect(constantTimeEqual('secret-token', 'secret-token')).toBe(true);
    expect(constantTimeEqual('secret-token', 'secret-tokeX')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('returns false for different-length strings WITHOUT throwing', () => {
    // The raw timingSafeEqual throws on differing lengths; this wrapper must not.
    expect(() => constantTimeEqual('short', 'a-much-longer-secret-value')).not.toThrow();
    expect(constantTimeEqual('short', 'a-much-longer-secret-value')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  it('distinguishes strings that share a long common prefix', () => {
    const a = 'x'.repeat(1000) + 'A';
    const b = 'x'.repeat(1000) + 'B';
    expect(constantTimeEqual(a, b)).toBe(false);
    expect(constantTimeEqual(a, a)).toBe(true);
  });
});

// ── #650/#696 — redactSecrets ────────────────────────────────────────────────
describe('#650/#696 redactSecrets', () => {
  it('masks provider-prefixed keys via the shared maskApiKey policy', () => {
    const line = 'auth failed for key sk-abcdef1234567890 while calling provider';
    const out = redactSecrets(line);
    expect(out).not.toContain('sk-abcdef1234567890');
    expect(out).toContain('***');
    // The masked form must be exactly what maskApiKey would produce.
    expect(out).toContain(maskApiKey('sk-abcdef1234567890'));
  });

  it('masks bare long hex (HMAC/master-key shaped) and base64-ish blobs', () => {
    const hex = 'a'.repeat(40);
    const blob = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg';
    const out = redactSecrets(`secret=${hex} token=${blob}`);
    expect(out).not.toContain(hex);
    expect(out).not.toContain(blob);
  });

  it('leaves ordinary short prose untouched', () => {
    const line = 'request 42 ok in 13ms';
    expect(redactSecrets(line)).toBe(line);
    expect(redactSecrets('')).toBe('');
  });
});

// ── #619 — GPU token verify against PREVIOUS secret during rotation ───────────
describe('#619 GPU_ACCESS_SECRET_PREVIOUS rotation overlap', () => {
  const CUR = 'c'.repeat(48);
  const PREV = 'p'.repeat(48);
  const prevSecret = process.env.GPU_ACCESS_SECRET;
  const prevPrevious = process.env.GPU_ACCESS_SECRET_PREVIOUS;

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.GPU_ACCESS_SECRET;
    else process.env.GPU_ACCESS_SECRET = prevSecret;
    if (prevPrevious === undefined) delete process.env.GPU_ACCESS_SECRET_PREVIOUS;
    else process.env.GPU_ACCESS_SECRET_PREVIOUS = prevPrevious;
  });

  it('accepts a token signed with the OLD secret after rotation, when PREVIOUS is set', () => {
    // Sign under the old secret.
    process.env.GPU_ACCESS_SECRET = PREV;
    delete process.env.GPU_ACCESS_SECRET_PREVIOUS;
    const tok = signGpuToken('tenant-rot');

    // Rotate: current secret becomes new; old moves to PREVIOUS.
    process.env.GPU_ACCESS_SECRET = CUR;
    process.env.GPU_ACCESS_SECRET_PREVIOUS = PREV;

    const payload = verifyGpuToken(tok);
    expect(payload.uid).toBe('tenant-rot');
  });

  it('still accepts a token signed with the NEW (current) secret', () => {
    process.env.GPU_ACCESS_SECRET = CUR;
    process.env.GPU_ACCESS_SECRET_PREVIOUS = PREV;
    const tok = signGpuToken('tenant-new');
    expect(verifyGpuToken(tok).uid).toBe('tenant-new');
  });

  it('rejects an OLD-secret token once PREVIOUS is dropped (rotation complete)', () => {
    process.env.GPU_ACCESS_SECRET = PREV;
    delete process.env.GPU_ACCESS_SECRET_PREVIOUS;
    const tok = signGpuToken('tenant-stale');

    process.env.GPU_ACCESS_SECRET = CUR;
    delete process.env.GPU_ACCESS_SECRET_PREVIOUS; // overlap window over
    expect(() => verifyGpuToken(tok)).toThrow(/Invalid signature/);
  });

  it('ignores a too-short PREVIOUS value (cannot weaken verify)', () => {
    process.env.GPU_ACCESS_SECRET = PREV;
    delete process.env.GPU_ACCESS_SECRET_PREVIOUS;
    const tok = signGpuToken('tenant-x');

    process.env.GPU_ACCESS_SECRET = CUR;
    process.env.GPU_ACCESS_SECRET_PREVIOUS = 'too-short'; // < 32 chars → ignored
    expect(() => verifyGpuToken(tok)).toThrow(/Invalid signature/);
  });
});

// ── #650 — Vault onAccess audit hook ─────────────────────────────────────────
describe('#650 Vault onAccess audit hook', () => {
  it('emits metadata-only events for store/retrieve/delete (never the value)', async () => {
    const events: VaultAccessEvent[] = [];
    const store = new FileVaultStore(join(mkdtempSync(join(tmpdir(), 'vault-audit-')), 'v.json'));
    const vault = new Vault(KEY_HEX, store, { onAccess: (e) => events.push(e) });

    await vault.storeSecret('api', 'sk-super-secret-value');
    await vault.retrieve('api');
    await vault.delete('api');

    const ops = events.map((e) => `${e.op}:${e.ok}`);
    expect(ops).toEqual(['store:true', 'retrieve:true', 'delete:true']);
    expect(events.every((e) => e.name === 'api')).toBe(true);
    expect(events.every((e) => typeof e.at === 'number')).toBe(true);
    // The plaintext must NEVER appear anywhere in the emitted events.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('sk-super-secret-value');
  });

  it('emits a failure event (reason=not-found) on a missing secret', async () => {
    const events: VaultAccessEvent[] = [];
    const store = new FileVaultStore(join(mkdtempSync(join(tmpdir(), 'vault-audit2-')), 'v.json'));
    const vault = new Vault(KEY_HEX, store, { onAccess: (e) => events.push(e) });
    await expect(vault.retrieve('nope')).rejects.toThrow(/not found/i);
    expect(events).toEqual([
      expect.objectContaining({ op: 'retrieve', ok: false, reason: 'not-found', name: 'nope' }),
    ]);
  });

  it('a throwing audit sink never breaks secret access', async () => {
    const store = new FileVaultStore(join(mkdtempSync(join(tmpdir(), 'vault-audit3-')), 'v.json'));
    const vault = new Vault(KEY_HEX, store, {
      onAccess: () => {
        throw new Error('sink exploded');
      },
    });
    await expect(vault.storeSecret('k', 'v')).resolves.toBeUndefined();
    expect(await vault.retrieve('k')).toBe('v');
  });

  it('still accepts the legacy numeric keyVersion third arg (back-compat)', async () => {
    const store = new FileVaultStore(join(mkdtempSync(join(tmpdir(), 'vault-legacy-')), 'v.json'));
    const vault = new Vault(KEY_HEX, store, 2); // old signature
    await vault.storeSecret('k', 'v');
    expect(await vault.retrieve('k')).toBe('v');
  });
});

// ── #646-ext — Vault blob field-shape validation ─────────────────────────────
describe('#646-ext Vault blob shape validation', () => {
  it('reports a blob missing the auth tag as corrupt (not a crypto error)', async () => {
    const store = new FileVaultStore(join(mkdtempSync(join(tmpdir(), 'vault-shape-')), 'v.json'));
    // Valid JSON, but missing `tag` → would otherwise blow up in setAuthTag.
    await store.set('api', JSON.stringify({ iv: 'aa', ciphertext: 'bb' }));
    const vault = new Vault(KEY_HEX, store);
    await expect(vault.retrieve('api')).rejects.toThrow(/corrupt.*iv, ciphertext, or tag/i);
  });

  it('reports a blob with a non-hex field as corrupt', async () => {
    const store = new FileVaultStore(join(mkdtempSync(join(tmpdir(), 'vault-shape2-')), 'v.json'));
    await store.set('api', JSON.stringify({ iv: 'zz', ciphertext: 'bb', tag: 'cc' }));
    const vault = new Vault(KEY_HEX, store);
    await expect(vault.retrieve('api')).rejects.toThrow(/corrupt/i);
  });

  it('a normal round-trip is unaffected', async () => {
    const store = new FileVaultStore(join(mkdtempSync(join(tmpdir(), 'vault-shape3-')), 'v.json'));
    const vault = new Vault(KEY_HEX, store);
    await vault.storeSecret('api', 'sk-value');
    expect(await vault.retrieve('api')).toBe('sk-value');
  });
});

// ── #647 — initAndScrubVaultFromEnv convenience ──────────────────────────────
describe('#647 initAndScrubVaultFromEnv', () => {
  let dir: string;
  const prevKey = process.env.VAULT_MASTER_KEY;
  const prevPath = process.env.VAULT_PATH;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-scrub-'));
    resetVault();
  });
  afterEach(() => {
    resetVault();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    if (prevKey === undefined) delete process.env.VAULT_MASTER_KEY;
    else process.env.VAULT_MASTER_KEY = prevKey;
    if (prevPath === undefined) delete process.env.VAULT_PATH;
    else process.env.VAULT_PATH = prevPath;
  });

  it('initializes the vault and scrubs VAULT_MASTER_KEY in one call', () => {
    process.env.VAULT_MASTER_KEY = KEY_HEX;
    process.env.VAULT_PATH = join(dir, 'v.json');
    const v = initAndScrubVaultFromEnv();
    expect(v).not.toBeNull();
    expect(getVault()).not.toBeNull();
    expect(process.env.VAULT_MASTER_KEY).toBeUndefined();
  });

  it('returns null and does NOT scrub when env is not configured', () => {
    delete process.env.VAULT_MASTER_KEY;
    delete process.env.VAULT_PATH;
    expect(initAndScrubVaultFromEnv()).toBeNull();
  });
});

// ── #698 — buildContentSecurityPolicy nonce primitive ────────────────────────
describe('#698 buildContentSecurityPolicy', () => {
  it('default (no nonce) reproduces the legacy unsafe-inline policy', () => {
    expect(buildContentSecurityPolicy()).toBe(SECURITY_HEADERS['Content-Security-Policy']);
    expect(buildContentSecurityPolicy()).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('a style nonce REPLACES unsafe-inline (no fallback)', () => {
    const csp = buildContentSecurityPolicy({ styleNonce: 'abc123' });
    expect(csp).toContain("style-src 'self' 'nonce-abc123'");
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it('a script nonce is added to script-src', () => {
    const csp = buildContentSecurityPolicy({ scriptNonce: 'xyz789' });
    expect(csp).toContain("script-src 'self' 'nonce-xyz789'");
  });

  it('the static SECURITY_HEADERS constant is unchanged (back-compat)', () => {
    // Wave-1/2/3 asserted the unsafe-inline default; it must remain.
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("'unsafe-inline'");
  });

  it('applySecurityHeaders honors a per-response style nonce', () => {
    const set: Record<string, string> = {};
    const res = {
      getHeader: (h: string) => set[h],
      setHeader: (h: string, v: string) => {
        set[h] = v;
      },
    } as unknown as ServerResponse;
    applySecurityHeaders(res, { styleNonce: 'nnn' });
    expect(set['Content-Security-Policy']).toContain("'nonce-nnn'");
    expect(set['Content-Security-Policy']).not.toContain("'unsafe-inline'");
    // Other headers still applied.
    expect(set['X-Frame-Options']).toBe('DENY');
  });

  it('applySecurityHeaders with no opts uses the static default', () => {
    const set: Record<string, string> = {};
    const res = {
      getHeader: (h: string) => set[h],
      setHeader: (h: string, v: string) => {
        set[h] = v;
      },
    } as unknown as ServerResponse;
    applySecurityHeaders(res);
    expect(set['Content-Security-Policy']).toBe(SECURITY_HEADERS['Content-Security-Policy']);
  });
});

// ── #686 — per-key cost-weighted check ───────────────────────────────────────
describe('#686 per-key cost-weighted rate limit', () => {
  it('a high-cost request consumes multiple units of the quota', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 10 }]]));
    const r1 = limiter.check('sk-a', { cost: 6 });
    expect(r1.allowed).toBe(true);
    expect(r1.current).toBe(6);
    const r2 = limiter.check('sk-a', { cost: 6 }); // 6 + 6 = 12 > 10
    expect(r2.allowed).toBe(false);
  });

  it('default cost (omitted) stays 1 — unchanged behavior', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 2 }]]));
    expect(limiter.check('sk-b').allowed).toBe(true); // 1
    expect(limiter.check('sk-b').allowed).toBe(true); // 2
    expect(limiter.check('sk-b').allowed).toBe(false); // 3 > 2
  });

  it('cost < 1 / non-finite is clamped to 1', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 2 }]]));
    expect(limiter.check('sk-c', { cost: 0 }).current).toBe(1);
    expect(limiter.check('sk-c', { cost: Number.NaN }).current).toBe(2);
  });
});

// ── #664 — clampNumber ───────────────────────────────────────────────────────
describe('#664 clampNumber', () => {
  it('clamps to the ceiling (max_tokens-style cost cap)', () => {
    expect(clampNumber(1e9, { max: 4096 })).toBe(4096);
    expect(clampNumber(100, { max: 4096 })).toBe(100);
  });
  it('clamps to the floor', () => {
    expect(clampNumber(-5, { min: 1 })).toBe(1);
    expect(clampNumber(50, { min: 1, max: 100 })).toBe(50);
  });
  it('non-finite returns min (or 0) — never propagates NaN/Infinity', () => {
    expect(clampNumber(Number.POSITIVE_INFINITY, { min: 1, max: 10 })).toBe(1);
    expect(clampNumber(Number.NaN)).toBe(0);
  });
});

// ── #662/#663 — BoundedString / BoundedArray schema helpers ──────────────────
describe('#662/#663 BoundedString / BoundedArray', () => {
  it('BoundedString rejects over-length content', () => {
    const S = Schemas.BoundedString(100);
    expect(validateInput('a'.repeat(100), S).ok).toBe(true);
    expect(validateInput('a'.repeat(101), S).ok).toBe(false);
  });
  it('BoundedString can also enforce a minimum', () => {
    const S = Schemas.BoundedString(100, { min: 1 });
    expect(validateInput('', S).ok).toBe(false);
    expect(validateInput('x', S).ok).toBe(true);
  });
  it('BoundedArray caps the element count', () => {
    const A = Schemas.BoundedArray(Schemas.BoundedString(10), 3);
    expect(validateInput(['a', 'b', 'c'], A).ok).toBe(true);
    expect(validateInput(['a', 'b', 'c', 'd'], A).ok).toBe(false);
  });
});

// ── contains-code 'any' mode requires >=2 hits in ONE language ───────────────
describe('contains-code any-mode threshold', () => {
  it('does NOT flag a lone keyword in ordinary prose', () => {
    const res = runContainsCode(
      { type: 'containsCode', language: 'any', hooks: ['afterResponse'] },
      { text: 'Please SELECT the option that best fits your needs.', hook: 'afterResponse' },
    );
    expect(res.pass).toBe(true); // not detected as code (was a false positive before)
  });

  it('still flags genuine multi-marker code', () => {
    const res = runContainsCode(
      { type: 'containsCode', language: 'any', hooks: ['afterResponse'] },
      { text: 'SELECT id FROM users WHERE active = 1;', hook: 'afterResponse' },
    );
    expect(res.pass).toBe(false); // detected → blocked (default not=false)
  });
});

// ── regex rule: pattern-length cap ───────────────────────────────────────────
describe('regex rule pattern-length cap', () => {
  it('rejects an absurdly long operator-supplied pattern', () => {
    const res = runRegexMatch(
      { type: 'regex', pattern: 'a'.repeat(5000), hooks: ['beforeRequest'] },
      { text: 'aaa', hook: 'beforeRequest' },
    );
    expect(res.pass).toBe(false);
    expect(res.reason ?? '').toMatch(/too long|not a string/i);
  });
  it('a normal pattern still works', () => {
    const res = runRegexMatch(
      { type: 'regex', pattern: 'hello', hooks: ['beforeRequest'] },
      { text: 'well hello there', hook: 'beforeRequest' },
    );
    expect(res.pass).toBe(true);
  });
});

// ── #685 — coerceGuardrailAction ─────────────────────────────────────────────
describe('#685 coerceGuardrailAction', () => {
  it('passes through valid actions', () => {
    expect(coerceGuardrailAction('block')).toBe('block');
    expect(coerceGuardrailAction('audit')).toBe('audit');
  });
  it('an unknown/typo action falls back to block (fail-closed), not allow', () => {
    expect(coerceGuardrailAction('adit')).toBe('block');
    expect(coerceGuardrailAction('allow')).toBe('block');
    expect(coerceGuardrailAction(undefined)).toBe('block');
    expect(coerceGuardrailAction(null)).toBe('block');
  });
  it('respects an explicit safe fallback', () => {
    expect(coerceGuardrailAction('nonsense', 'audit')).toBe('audit');
  });
});

// ── csrf nonce min-length guard ──────────────────────────────────────────────
describe('csrf nonce min-length guard', () => {
  const secret = 'csrf-secret-w4';
  it('still verifies a normally generated token', () => {
    const tok = generateCsrfToken(secret);
    expect(verifyCsrfToken(tok, secret)).toBe(true);
  });
  it('rejects a degenerate token with a tiny nonce', () => {
    // Even if an attacker could somehow produce a matching HMAC for a 1-char
    // nonce, the structural guard rejects it first.
    expect(verifyCsrfToken('a.' + 'b'.repeat(43), secret)).toBe(false);
  });
});

// ── null-safety: safeParseInt strict for arbitrary radix ─────────────────────
describe('safeParseInt strict mode (arbitrary radix)', () => {
  it('strict mode now enforces validity for radix 2', () => {
    expect(safeParseInt('1012', 2, { strict: true })).toBeNaN(); // 2 is not a binary digit
    expect(safeParseInt('1010', 2, { strict: true })).toBe(10);
  });
  it('strict mode enforces validity for radix 36', () => {
    expect(safeParseInt('zz', 36, { strict: true })).toBe(35 * 36 + 35);
    expect(safeParseInt('z!', 36, { strict: true })).toBeNaN();
  });
  it('out-of-range radix returns NaN in strict mode', () => {
    expect(safeParseInt('10', 40, { strict: true })).toBeNaN();
  });
  it('non-strict default is unchanged', () => {
    expect(safeParseInt('1012', 2)).toBe(5); // parseInt('1012', 2) → reads "101" = 5
  });
});

// ── #612 — isDevBypassActive predicate ───────────────────────────────────────
describe('#612 isDevBypassActive', () => {
  const prevEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  });

  it('is active only when allowDevBypass AND NODE_ENV=development', () => {
    process.env.NODE_ENV = 'development';
    expect(isDevBypassActive({ allowDevBypass: true })).toBe(true);
    expect(isDevBypassActive({ allowDevBypass: false })).toBe(false);
  });

  it('is NEVER active in production even with allowDevBypass', () => {
    process.env.NODE_ENV = 'production';
    expect(isDevBypassActive({ allowDevBypass: true })).toBe(false);
  });

  it('is inactive when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    expect(isDevBypassActive({ allowDevBypass: true })).toBe(false);
  });
});
