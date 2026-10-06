// ── SSRF Protection — unit suite ─────────────────────────────────────────────
// Tests isPrivateUrl, validateEndpointUrl, validateRemoteEndpoint, and the
// IPv4 normalization edge cases (octal, hex, packed decimal).

import { describe, it, expect } from 'vitest';
import {
  isPrivateUrl,
  validateEndpointUrl,
  validateRemoteEndpoint,
  SSRF_BLOCKED_HOSTS,
  SSRF_BLOCKED_IP_PATTERNS,
} from '../src/gateway/pipeline/ssrf-protection';

// ── isPrivateUrl ─────────────────────────────────────────────────────────────

describe('isPrivateUrl', () => {
  // ── Loopback / localhost ────────────────────────────────────────────────
  it('blocks 127.0.0.1', () => {
    expect(isPrivateUrl('http://127.0.0.1/')).toBe(true);
  });

  it('blocks 127.0.0.2 (non-standard loopback)', () => {
    expect(isPrivateUrl('http://127.0.0.2/')).toBe(true);
  });

  it('blocks localhost hostname', () => {
    expect(isPrivateUrl('http://localhost/')).toBe(true);
  });

  it('blocks sub.localhost', () => {
    expect(isPrivateUrl('http://sub.localhost/')).toBe(true);
  });

  // ── RFC-1918 private ranges ────────────────────────────────────────────
  it('blocks 10.0.0.1 (RFC-1918)', () => {
    expect(isPrivateUrl('http://10.0.0.1/')).toBe(true);
  });

  it('blocks 10.255.255.255', () => {
    expect(isPrivateUrl('http://10.255.255.255/')).toBe(true);
  });

  it('blocks 192.168.1.1 (RFC-1918)', () => {
    expect(isPrivateUrl('http://192.168.1.1/')).toBe(true);
  });

  it('blocks 172.16.0.1 (RFC-1918 start)', () => {
    expect(isPrivateUrl('http://172.16.0.1/')).toBe(true);
  });

  it('blocks 172.31.255.255 (RFC-1918 end)', () => {
    expect(isPrivateUrl('http://172.31.255.255/')).toBe(true);
  });

  it('allows 172.15.0.1 (outside RFC-1918)', () => {
    expect(isPrivateUrl('http://172.15.0.1/')).toBe(false);
  });

  it('allows 172.32.0.1 (outside RFC-1918)', () => {
    expect(isPrivateUrl('http://172.32.0.1/')).toBe(false);
  });

  // ── Link-local & cloud metadata ────────────────────────────────────────
  it('blocks 169.254.0.1 (link-local)', () => {
    expect(isPrivateUrl('http://169.254.0.1/')).toBe(true);
  });

  it('blocks 169.254.169.254 (AWS metadata)', () => {
    expect(isPrivateUrl('http://169.254.169.254/')).toBe(true);
  });

  // ── Carrier-grade NAT (100.64.0.0/10) ─────────────────────────────────
  it('blocks 100.64.0.1 (CGNAT)', () => {
    expect(isPrivateUrl('http://100.64.0.1/')).toBe(true);
  });

  it('blocks 100.127.255.255 (CGNAT end)', () => {
    expect(isPrivateUrl('http://100.127.255.255/')).toBe(true);
  });

  it('allows 100.63.255.255 (outside CGNAT)', () => {
    expect(isPrivateUrl('http://100.63.255.255/')).toBe(false);
  });

  it('allows 100.128.0.1 (outside CGNAT)', () => {
    expect(isPrivateUrl('http://100.128.0.1/')).toBe(false);
  });

  // ── Benchmarking range (198.18.0.0/15) ────────────────────────────────
  it('blocks 198.18.0.1 (benchmarking)', () => {
    expect(isPrivateUrl('http://198.18.0.1/')).toBe(true);
  });

  it('blocks 198.19.255.255 (benchmarking end)', () => {
    expect(isPrivateUrl('http://198.19.255.255/')).toBe(true);
  });

  it('allows 198.20.0.1 (outside benchmarking)', () => {
    expect(isPrivateUrl('http://198.20.0.1/')).toBe(false);
  });

  // ── IPv6 ──────────────────────────────────────────────────────────────
  it('blocks ::1 (IPv6 loopback)', () => {
    expect(isPrivateUrl('http://[::1]/')).toBe(true);
  });

  it('blocks :: (IPv6 unspecified)', () => {
    expect(isPrivateUrl('http://[::]/')).toBe(true);
  });

  it('blocks fe80:: (IPv6 link-local)', () => {
    expect(isPrivateUrl('http://[fe80::1]/')).toBe(true);
  });

  it('blocks fc00:: (IPv6 ULA)', () => {
    expect(isPrivateUrl('http://[fc00::1]/')).toBe(true);
  });

  it('blocks fd00:: (IPv6 ULA-C)', () => {
    expect(isPrivateUrl('http://[fd00::1]/')).toBe(true);
  });

  it('blocks 2001:db8:: (IPv6 documentation)', () => {
    expect(isPrivateUrl('http://[2001:db8::1]/')).toBe(true);
  });

  // ── Blocked hostnames ─────────────────────────────────────────────────
  it('blocks metadata.google.internal', () => {
    expect(isPrivateUrl('http://metadata.google.internal/')).toBe(true);
  });

  it('blocks kubernetes.default.svc', () => {
    expect(isPrivateUrl('http://kubernetes.default.svc/')).toBe(true);
  });

  // ── Special addresses ─────────────────────────────────────────────────
  it('blocks 0.0.0.0', () => {
    expect(isPrivateUrl('http://0.0.0.0/')).toBe(true);
  });

  it('blocks 255.255.255.255 (broadcast)', () => {
    expect(isPrivateUrl('http://255.255.255.255/')).toBe(true);
  });

  it('blocks multicast 224.0.0.1', () => {
    expect(isPrivateUrl('http://224.0.0.1/')).toBe(true);
  });

  // ── file:// ────────────────────────────────────────────────────────────
  it('blocks file:// URLs', () => {
    expect(isPrivateUrl('file:///etc/passwd')).toBe(true);
  });

  // ── Invalid URLs ───────────────────────────────────────────────────────
  it('blocks malformed URLs', () => {
    expect(isPrivateUrl('not-a-url')).toBe(true);
  });

  it('blocks empty string', () => {
    expect(isPrivateUrl('')).toBe(true);
  });

  // ── Public addresses ───────────────────────────────────────────────────
  it('allows public IP 8.8.8.8', () => {
    expect(isPrivateUrl('http://8.8.8.8/')).toBe(false);
  });

  it('allows public IP 1.1.1.1', () => {
    expect(isPrivateUrl('http://1.1.1.1/')).toBe(false);
  });

  it('allows public IP 203.0.113.1', () => {
    // Documentation range — not in blocklist for isPrivateUrl
    expect(isPrivateUrl('http://203.0.113.1/')).toBe(false);
  });

  it('allows public domain api.example.com', () => {
    expect(isPrivateUrl('https://api.example.com/v1')).toBe(false);
  });

  it('allows public domain with path', () => {
    expect(isPrivateUrl('https://groq.com/api/v1/chat')).toBe(false);
  });
});

// ── validateEndpointUrl ───────────────────────────────────────────────────────

describe('validateEndpointUrl', () => {
  it('does not throw for a public URL', () => {
    expect(() => validateEndpointUrl('https://api.example.com/v1')).not.toThrow();
  });

  it('throws for localhost', () => {
    expect(() => validateEndpointUrl('http://localhost:8080')).toThrow(/SSRF blocked/);
  });

  it('throws for 127.0.0.1', () => {
    expect(() => validateEndpointUrl('http://127.0.0.1/')).toThrow(/SSRF blocked/);
  });

  it('throws for RFC-1918 10.x', () => {
    expect(() => validateEndpointUrl('http://10.0.0.1/')).toThrow(/SSRF blocked/);
  });

  it('throws for RFC-1918 192.168.x', () => {
    expect(() => validateEndpointUrl('http://192.168.1.1/')).toThrow(/SSRF blocked/);
  });

  it('throws for RFC-1918 172.16.x', () => {
    expect(() => validateEndpointUrl('http://172.16.0.1/')).toThrow(/SSRF blocked/);
  });

  it('throws for cloud metadata address', () => {
    expect(() => validateEndpointUrl('http://169.254.169.254/')).toThrow(/SSRF blocked/);
  });

  it('throws for metadata.google.internal', () => {
    expect(() => validateEndpointUrl('http://metadata.google.internal/')).toThrow(/SSRF blocked/);
  });

  it('throws for kubernetes.default.svc', () => {
    expect(() => validateEndpointUrl('http://kubernetes.default.svc/')).toThrow(/SSRF blocked/);
  });

  it('throws for sub.localhost', () => {
    expect(() => validateEndpointUrl('http://sub.localhost/')).toThrow(/SSRF blocked|reserved/);
  });

  it('throws for IPv6 loopback', () => {
    expect(() => validateEndpointUrl('http://[::1]/')).toThrow(/SSRF blocked/);
  });

  it('throws for an invalid URL', () => {
    expect(() => validateEndpointUrl('not-a-url')).toThrow(/Invalid URL/);
  });

  it('throws for empty string', () => {
    expect(() => validateEndpointUrl('')).toThrow(/Invalid URL/);
  });

  it('does not throw for 8.8.8.8', () => {
    expect(() => validateEndpointUrl('https://8.8.8.8/')).not.toThrow();
  });

  it('does not throw for HTTPS with path and port', () => {
    expect(() => validateEndpointUrl('https://api.groq.com:443/openai/v1')).not.toThrow();
  });
});

// ── validateRemoteEndpoint ────────────────────────────────────────────────────

describe('validateRemoteEndpoint', () => {
  it('allows loopback 127.0.0.1 (local dev)', () => {
    expect(() => validateRemoteEndpoint('http://127.0.0.1:8000/')).not.toThrow();
  });

  it('allows loopback localhost', () => {
    expect(() => validateRemoteEndpoint('http://localhost:8000/')).not.toThrow();
  });

  it('allows loopback ::1', () => {
    expect(() => validateRemoteEndpoint('http://[::1]:8000/')).not.toThrow();
  });

  it('allows public GPU endpoint', () => {
    expect(() => validateRemoteEndpoint('https://gpu.example.com:8000/')).not.toThrow();
  });

  it('blocks RFC-1918 10.x', () => {
    expect(() => validateRemoteEndpoint('http://10.0.0.5:8000/')).toThrow(/SSRF blocked/);
  });

  it('blocks 192.168.x', () => {
    expect(() => validateRemoteEndpoint('http://192.168.1.100:8000/')).toThrow(/SSRF blocked/);
  });

  it('blocks cloud metadata', () => {
    expect(() => validateRemoteEndpoint('http://169.254.169.254/')).toThrow(/SSRF blocked/);
  });

  it('throws for invalid URL', () => {
    expect(() => validateRemoteEndpoint('bad-url')).toThrow(/Invalid URL/);
  });
});

// ── IPv4 normalization / alternate format bypass attempts ─────────────────────

describe('isPrivateUrl — alternate IPv4 formats (bypass attempts)', () => {
  // Decimal-packed single integer: 0x7f000001 = 127.0.0.1 = 2130706433
  it('blocks decimal-packed IPv4 2130706433 (127.0.0.1)', () => {
    expect(isPrivateUrl('http://2130706433/')).toBe(true);
  });

  // Three-part notation: 127.0.1 → 127.0.0.1
  it('blocks three-part 127.0.1', () => {
    expect(isPrivateUrl('http://127.0.1/')).toBe(true);
  });

  // Octal notation: 0177.0.0.1 = 127.0.0.1
  it('blocks octal 0177.0.0.1', () => {
    expect(isPrivateUrl('http://0177.0.0.1/')).toBe(true);
  });

  // Hex notation: 0x7f.0.0.1 = 127.0.0.1
  it('blocks hex 0x7f.0.0.1', () => {
    expect(isPrivateUrl('http://0x7f.0.0.1/')).toBe(true);
  });

  // Mixed notation: 10.0x00.0.1 = 10.0.0.1
  it('blocks mixed hex 10.0x00.0.1', () => {
    expect(isPrivateUrl('http://10.0x00.0.1/')).toBe(true);
  });

  // IPv4-mapped IPv6: ::ffff:127.0.0.1
  it('blocks IPv4-mapped IPv6 ::ffff:127.0.0.1', () => {
    expect(isPrivateUrl('http://[::ffff:127.0.0.1]/')).toBe(true);
  });

  // IPv4-mapped IPv6 for 10.0.0.1
  it('blocks IPv4-mapped IPv6 ::ffff:10.0.0.1', () => {
    expect(isPrivateUrl('http://[::ffff:10.0.0.1]/')).toBe(true);
  });
});

// ── Metadata constants ────────────────────────────────────────────────────────

describe('SSRF constants', () => {
  it('exports SSRF_BLOCKED_HOSTS as a non-empty array', () => {
    expect(Array.isArray(SSRF_BLOCKED_HOSTS)).toBe(true);
    expect(SSRF_BLOCKED_HOSTS.length).toBeGreaterThan(0);
  });

  it('SSRF_BLOCKED_HOSTS includes localhost', () => {
    expect(SSRF_BLOCKED_HOSTS).toContain('localhost');
  });

  it('SSRF_BLOCKED_HOSTS includes metadata.google.internal', () => {
    expect(SSRF_BLOCKED_HOSTS).toContain('metadata.google.internal');
  });

  it('exports SSRF_BLOCKED_IP_PATTERNS as a non-empty array', () => {
    expect(Array.isArray(SSRF_BLOCKED_IP_PATTERNS)).toBe(true);
    expect(SSRF_BLOCKED_IP_PATTERNS.length).toBeGreaterThan(0);
  });

  it('every SSRF_BLOCKED_IP_PATTERNS entry has a pattern and label', () => {
    for (const entry of SSRF_BLOCKED_IP_PATTERNS) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('SSRF_BLOCKED_IP_PATTERNS covers 127.x', () => {
    const pat = SSRF_BLOCKED_IP_PATTERNS.find(e => e.label === 'localhost');
    expect(pat?.pattern.test('127.0.0.1')).toBe(true);
  });

  it('SSRF_BLOCKED_IP_PATTERNS covers 10.x', () => {
    const pat = SSRF_BLOCKED_IP_PATTERNS.find(e => e.label === 'private-10');
    expect(pat?.pattern.test('10.0.0.1')).toBe(true);
  });

  it('SSRF_BLOCKED_IP_PATTERNS covers 192.168.x', () => {
    const pat = SSRF_BLOCKED_IP_PATTERNS.find(e => e.label === 'private-192');
    expect(pat?.pattern.test('192.168.0.1')).toBe(true);
  });

  it('SSRF_BLOCKED_IP_PATTERNS covers IPv6 loopback ::1', () => {
    const pat = SSRF_BLOCKED_IP_PATTERNS.find(e => e.label === 'ipv6-loopback');
    expect(pat?.pattern.test('::1')).toBe(true);
  });

  it('SSRF_BLOCKED_IP_PATTERNS covers cloud-metadata 169.254.169.254', () => {
    const pat = SSRF_BLOCKED_IP_PATTERNS.find(e => e.label === 'cloud-metadata');
    expect(pat?.pattern.test('169.254.169.254')).toBe(true);
  });
});
