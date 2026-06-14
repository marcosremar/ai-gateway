/**
 * Cross-ownership harvest — Security deep (x6).
 *
 * Implements the *cluster-file* siblings of audit items whose Location points
 * into this file cluster but were implemented out-of-cluster by domain-7 agents
 * (so the documented protection was absent from the named files themselves):
 *
 *   src/gateway/pipeline/ssrf-protection.ts
 *     - #657  http(s)-only scheme allowlist (isAllowedScheme / ALLOWED_URL_SCHEMES)
 *             wired into isPrivateUrl / validateEndpointUrl / isPrivateUrlResolved.
 *     - #659  validateEndpointUrlResolvedStrict — fail-CLOSED on DNS error.
 *     - #655  ...strict variant also resolves dot-less (single-label) hosts.
 *
 *   src/contracts/index.ts
 *     - #652  SsrfSafeUrlSchema / isSsrfSafeUrl — meetingUrl rejects private /
 *             metadata / non-http(s) targets (back-compat: public URLs pass).
 *     - #674  AvatarSpeakRequestSchema.audio bounded (MAX_AVATAR_AUDIO_CHARS).
 *
 *   src/gateway/providers/cloud/dlp.ts
 *     - #681  luhnCheck + opt-in Luhn gating of credit-card matches.
 *     - #682  redactPII — mask PII in place so a request can proceed.
 *     - #685  DLPConfigSchema / validateDLPConfig / coerceDLPAction.
 *
 *   src/gateway/providers/cloud/guardrails.ts
 *     - #680  normalizeForMatching + opt-in de-obfuscation pass (leetspeak/spacing).
 *     - #685  GuardrailConfigSchema / validateGuardrailConfig / coerceGuardrailAction.
 *
 * Unit-only. DNS is mocked; fetch is NEVER invoked. Defensive hardening only —
 * no wire-format or live-server wiring is changed; every new behavior is either
 * additive or opt-in, so existing back-compat tests are unaffected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DNS mock (must be declared before importing the SSRF module) ──────────────
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import {
  ALLOWED_URL_SCHEMES,
  isAllowedScheme,
  isPrivateUrl,
  isPrivateUrlResolved,
  validateEndpointUrl,
  validateEndpointUrlResolved,
  validateEndpointUrlResolvedStrict,
} from '../../src/gateway/pipeline/ssrf-protection';

import {
  SsrfSafeUrlSchema,
  isSsrfSafeUrl,
  BotJoinRequestSchema,
  RecallJoinRequestSchema,
  AvatarSpeakRequestSchema,
  MAX_AVATAR_AUDIO_CHARS,
} from '../../src/contracts/index';

import {
  detectPII,
  redactPII,
  luhnCheck,
  validateDLPConfig,
  coerceDLPAction,
  type DLPConfig,
} from '../../src/gateway/providers/cloud/dlp';

import {
  checkContent,
  normalizeForMatching,
  validateGuardrailConfig,
  coerceGuardrailAction,
  type GuardrailConfig,
} from '../../src/gateway/providers/cloud/guardrails';

beforeEach(() => {
  lookupMock.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// #657 — SSRF scheme allowlist
// ─────────────────────────────────────────────────────────────────────────────
describe('#657 ssrf scheme allowlist', () => {
  it('ALLOWED_URL_SCHEMES is exactly http: and https:', () => {
    expect([...ALLOWED_URL_SCHEMES].sort()).toEqual(['http:', 'https:']);
  });

  it('isAllowedScheme accepts http/https only, fails closed on junk', () => {
    expect(isAllowedScheme('http://example.com')).toBe(true);
    expect(isAllowedScheme('https://example.com')).toBe(true);
    expect(isAllowedScheme('HTTPS://EXAMPLE.COM')).toBe(true);
    expect(isAllowedScheme('ftp://host/x')).toBe(false);
    expect(isAllowedScheme('gopher://host')).toBe(false);
    expect(isAllowedScheme('data:text/plain,hi')).toBe(false);
    expect(isAllowedScheme('file:///etc/passwd')).toBe(false);
    expect(isAllowedScheme('not a url')).toBe(false);
    expect(isAllowedScheme('')).toBe(false);
  });

  it('isPrivateUrl treats a non-http(s) scheme as unsafe even on a PUBLIC host', () => {
    // This is the concrete gap: ftp:// to a public-looking host previously
    // returned false (allowed). It must now be flagged.
    expect(isPrivateUrl('ftp://internal/secret')).toBe(true);
    expect(isPrivateUrl('ftp://example.com/x')).toBe(true);
    expect(isPrivateUrl('gopher://example.com/x')).toBe(true);
    expect(isPrivateUrl('file:///etc/passwd')).toBe(true);
    // ...but a normal public https URL is still allowed.
    expect(isPrivateUrl('https://example.com/ok')).toBe(false);
  });

  it('validateEndpointUrl throws on a non-http(s) scheme to a public host', () => {
    expect(() => validateEndpointUrl('ftp://example.com/x')).toThrow(/scheme|SSRF/i);
    expect(() => validateEndpointUrl('gopher://example.com/x')).toThrow(/scheme|SSRF/i);
    expect(() => validateEndpointUrl('https://example.com/ok')).not.toThrow();
  });

  it('isPrivateUrlResolved short-circuits a bad scheme without DNS', async () => {
    await expect(isPrivateUrlResolved('ftp://example.com/x')).resolves.toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #659 / #655 — fail-closed strict resolved validator + dot-less resolution
// ─────────────────────────────────────────────────────────────────────────────
describe('#659/#655 validateEndpointUrlResolvedStrict', () => {
  it('non-strict resolved validator FAILS OPEN on a DNS error (back-compat)', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    // example.com has a dot → resolution attempted → error swallowed → allowed.
    await expect(validateEndpointUrlResolved('https://example.com/x')).resolves.toBeUndefined();
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('strict resolved validator FAILS CLOSED on a DNS error (#659)', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(validateEndpointUrlResolvedStrict('https://example.com/x')).rejects.toThrow(
      /SSRF/i,
    );
  });

  it('strict validator blocks when the host resolves to a private IP', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(validateEndpointUrlResolvedStrict('https://evil.attacker.net/x')).rejects.toThrow(
      /SSRF/i,
    );
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('strict validator allows a host that resolves to a public IP', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(validateEndpointUrlResolvedStrict('https://example.com/x')).resolves.toBeUndefined();
  });

  it('strict validator RESOLVES dot-less single-label hosts (#655); non-strict skips them', async () => {
    // Non-strict: a dot-less host (e.g. `etcd`) skips resolution entirely.
    lookupMock.mockResolvedValue([{ address: '10.0.0.9', family: 4 }]);
    await expect(validateEndpointUrlResolved('https://etcd/x')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();

    lookupMock.mockReset();
    // Strict: the same dot-less host IS resolved, and a private result is blocked.
    lookupMock.mockResolvedValue([{ address: '10.0.0.9', family: 4 }]);
    await expect(validateEndpointUrlResolvedStrict('https://etcd/x')).rejects.toThrow(/SSRF/i);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #652 — SsrfSafeUrlSchema / meetingUrl
// ─────────────────────────────────────────────────────────────────────────────
describe('#652 SsrfSafeUrlSchema', () => {
  it('isSsrfSafeUrl accepts public http(s), rejects private/metadata/non-http', () => {
    expect(isSsrfSafeUrl('https://zoom.us/j/123')).toBe(true);
    expect(isSsrfSafeUrl('https://teams.microsoft.com/l/meetup/abc')).toBe(true);

    expect(isSsrfSafeUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isSsrfSafeUrl('http://127.0.0.1/')).toBe(false);
    expect(isSsrfSafeUrl('http://localhost/x')).toBe(false);
    expect(isSsrfSafeUrl('http://10.0.0.5/x')).toBe(false);
    expect(isSsrfSafeUrl('http://192.168.1.1/x')).toBe(false);
    expect(isSsrfSafeUrl('http://172.16.0.1/x')).toBe(false);
    expect(isSsrfSafeUrl('http://[::1]/x')).toBe(false);
    expect(isSsrfSafeUrl('http://metadata.google.internal/x')).toBe(false);
    expect(isSsrfSafeUrl('http://2130706433/x')).toBe(false); // decimal 127.0.0.1
    expect(isSsrfSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSsrfSafeUrl('ftp://example.com/x')).toBe(false);
    expect(isSsrfSafeUrl('not a url')).toBe(false);
  });

  it('SsrfSafeUrlSchema parses public URLs and rejects unsafe ones', () => {
    expect(SsrfSafeUrlSchema.safeParse('https://zoom.us/j/9').success).toBe(true);
    expect(SsrfSafeUrlSchema.safeParse('http://169.254.169.254/').success).toBe(false);
    expect(SsrfSafeUrlSchema.safeParse('http://localhost/').success).toBe(false);
  });

  it('BotJoinRequestSchema + RecallJoinRequestSchema enforce SSRF-safe meetingUrl', () => {
    expect(BotJoinRequestSchema.safeParse({ meetingUrl: 'https://meet.google.com/abc' }).success).toBe(true);
    expect(BotJoinRequestSchema.safeParse({ meetingUrl: 'http://169.254.169.254/' }).success).toBe(false);

    expect(RecallJoinRequestSchema.safeParse({ meetingUrl: 'https://zoom.us/j/1' }).success).toBe(true);
    expect(RecallJoinRequestSchema.safeParse({ meetingUrl: 'http://127.0.0.1/' }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #674 — Avatar audio base64 bound
// ─────────────────────────────────────────────────────────────────────────────
describe('#674 AvatarSpeakRequestSchema.audio bound', () => {
  it('accepts a reasonable base64 blob', () => {
    const ok = AvatarSpeakRequestSchema.safeParse({ audio: 'A'.repeat(1000) });
    expect(ok.success).toBe(true);
  });

  it('rejects an audio blob over MAX_AVATAR_AUDIO_CHARS', () => {
    const tooBig = AvatarSpeakRequestSchema.safeParse({ audio: 'A'.repeat(MAX_AVATAR_AUDIO_CHARS + 1) });
    expect(tooBig.success).toBe(false);
  });

  it('still allows the audio field to be omitted (back-compat)', () => {
    expect(AvatarSpeakRequestSchema.safeParse({ text: 'hello' }).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #681 — Luhn check + opt-in card gating
// ─────────────────────────────────────────────────────────────────────────────
describe('#681 luhnCheck + opt-in DLP card gating', () => {
  it('luhnCheck validates real card numbers and rejects random digit runs', () => {
    expect(luhnCheck('4111111111111111')).toBe(true); // canonical Visa test number
    expect(luhnCheck('4111 1111 1111 1111')).toBe(true); // separators ignored
    expect(luhnCheck('4222222222222222')).toBe(false); // fails Luhn
    expect(luhnCheck('1234567890123456')).toBe(false);
    expect(luhnCheck('abcd')).toBe(false);
  });

  const cfg: DLPConfig = { enabled: true, patterns: { creditCard: true }, action: 'flag' };

  it('without luhnValidate, a brand-prefixed non-card still matches (back-compat)', () => {
    const r = detectPII('card 4222222222222222 here', cfg);
    expect(r.matches.some((m) => m.type === 'creditCard')).toBe(true);
  });

  it('with luhnValidate, a non-Luhn card-shaped run is dropped', () => {
    const r = detectPII('card 4222222222222222 here', cfg, { luhnValidate: true });
    expect(r.matches.some((m) => m.type === 'creditCard')).toBe(false);
  });

  it('with luhnValidate, a real card number still matches', () => {
    const r = detectPII('card 4111111111111111 here', cfg, { luhnValidate: true });
    expect(r.matches.some((m) => m.type === 'creditCard')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #682 — redactPII
// ─────────────────────────────────────────────────────────────────────────────
describe('#682 redactPII', () => {
  const cfg: DLPConfig = { enabled: true, patterns: { email: true, creditCard: true }, action: 'block' };

  it('masks detected PII in place and returns the result', () => {
    const { text, result } = redactPII('email me at john@example.com please', cfg);
    expect(text).not.toContain('john@example.com');
    expect(text).toContain('please');
    expect(text).toContain('email me at');
    expect(result.detected).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('redacts multiple matches without corrupting offsets', () => {
    const { text } = redactPII('a@b.com and c@d.com', cfg);
    expect(text).not.toContain('a@b.com');
    expect(text).not.toContain('c@d.com');
    expect(text).toContain(' and ');
  });

  it('returns the text unchanged when there is no PII', () => {
    const { text, result } = redactPII('nothing sensitive here', cfg);
    expect(text).toBe('nothing sensitive here');
    expect(result.matches.length).toBe(0);
  });

  it('redacts even when the supplied config is disabled (forces detection)', () => {
    const { text } = redactPII('mail x@y.com', { ...cfg, enabled: false });
    expect(text).not.toContain('x@y.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #685 — DLP config validation + action coercion
// ─────────────────────────────────────────────────────────────────────────────
describe('#685 validateDLPConfig + coerceDLPAction', () => {
  it('accepts a well-formed config', () => {
    const v = validateDLPConfig({ enabled: true, patterns: { ssn: true }, action: 'block', minMatches: 2 });
    expect(v.ok).toBe(true);
  });

  it('rejects a malformed action and reports an error path', () => {
    const v = validateDLPConfig({ enabled: true, action: 'bock' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/action/);
  });

  it('rejects a non-boolean enabled and a bad custom pattern shape', () => {
    expect(validateDLPConfig({ enabled: 'yes', action: 'flag' }).ok).toBe(false);
    expect(
      validateDLPConfig({ enabled: true, action: 'flag', customPatterns: [{ name: '', pattern: '' }] }).ok,
    ).toBe(false);
  });

  it('coerceDLPAction maps unknown values to a safe fallback', () => {
    expect(coerceDLPAction('block')).toBe('block');
    expect(coerceDLPAction('allow')).toBe('allow');
    expect(coerceDLPAction('bogus')).toBe('flag'); // default fallback
    expect(coerceDLPAction(undefined, 'block')).toBe('block');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #680 — guardrail de-obfuscation (opt-in)
// ─────────────────────────────────────────────────────────────────────────────
describe('#680 guardrail de-obfuscation', () => {
  const cfg: GuardrailConfig = {
    enabled: true,
    filters: { violence: true, hate: true },
    action: 'block',
    confidenceThreshold: 1,
  };

  it('normalizeForMatching collapses spacing and maps leetspeak', () => {
    expect(normalizeForMatching('k i l l')).toBe('kill');
    expect(normalizeForMatching('k1ll')).toBe('kill');
    expect(normalizeForMatching('h.a-t_e')).toBe('hate');
  });

  it('plain-text behavior is UNCHANGED when deobfuscate is off (back-compat)', () => {
    // A single keyword hit yields confidence 20, exactly as before.
    const plain = checkContent('I will kill it', cfg);
    expect(plain.categories).toContain('violence');
    expect(plain.confidence).toBe(20);

    // An obfuscated string is NOT caught without the opt-in.
    const obf = checkContent('k i l l', cfg);
    expect(obf.flagged).toBe(false);
  });

  it('catches spaced / leetspeak obfuscation when deobfuscate is on', () => {
    const spaced = checkContent('k i l l them', cfg, { deobfuscate: true });
    expect(spaced.categories).toContain('violence');

    const leet = checkContent('total h4te speech', cfg, { deobfuscate: true });
    expect(leet.categories).toContain('hate');
  });

  it('does not over-flag clean text even with deobfuscate on', () => {
    const clean = checkContent('a perfectly pleasant message', cfg, { deobfuscate: true });
    expect(clean.flagged).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #685 (guardrails sibling) — config validation + action coercion
// ─────────────────────────────────────────────────────────────────────────────
describe('#685 validateGuardrailConfig + coerceGuardrailAction', () => {
  it('accepts a well-formed guardrail config', () => {
    const v = validateGuardrailConfig({
      enabled: true,
      filters: { hate: true },
      action: 'audit',
      confidenceThreshold: 50,
    });
    expect(v.ok).toBe(true);
  });

  it('rejects a typo action and an out-of-range threshold', () => {
    expect(validateGuardrailConfig({ enabled: true, action: 'bock' }).ok).toBe(false);
    expect(
      validateGuardrailConfig({ enabled: true, action: 'block', confidenceThreshold: 500 }).ok,
    ).toBe(false);
  });

  it('coerceGuardrailAction maps unknown values to a safe fallback (block)', () => {
    expect(coerceGuardrailAction('audit')).toBe('audit');
    expect(coerceGuardrailAction('allow')).toBe('allow');
    expect(coerceGuardrailAction('adit')).toBe('block'); // typo → fail-closed
    expect(coerceGuardrailAction(undefined)).toBe('block');
  });
});
