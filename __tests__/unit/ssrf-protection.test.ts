import { afterEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted to the top of the file, so the mock factory cannot
// close over a regular top-level binding. Use vi.hoisted to declare the
// mock stub so it's initialized before the mock runs.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}));

import {
  isPrivateUrl,
  isPrivateUrlResolved,
  validateRemoteEndpoint,
  validateRemoteEndpointResolved,
  validateEndpointUrl,
  SSRF_BLOCKED_HOSTS,
} from '../../src/gateway/pipeline/ssrf-protection';

afterEach(() => {
  lookupMock.mockReset();
});

// ── isPrivateUrl: loopback ────────────────────────────────────────────────────

describe('isPrivateUrl — loopback', () => {
  it('blocks standard loopback 127.0.0.1', () => {
    expect(isPrivateUrl('http://127.0.0.1/path')).toBe(true);
  });

  it('blocks shortened loopback 127.1', () => {
    expect(isPrivateUrl('http://127.1/test')).toBe(true);
  });

  it('blocks decimal-encoded loopback 2130706433', () => {
    expect(isPrivateUrl('http://2130706433/test')).toBe(true);
  });

  it('blocks hex-encoded loopback 0x7f000001', () => {
    expect(isPrivateUrl('http://0x7f000001/test')).toBe(true);
  });

  it('blocks octal-encoded loopback 0177.0.0.1', () => {
    expect(isPrivateUrl('http://0177.0.0.1/test')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 loopback ::ffff:127.0.0.1', () => {
    expect(isPrivateUrl('http://[::ffff:127.0.0.1]/test')).toBe(true);
  });

  it('blocks IPv6 loopback ::1', () => {
    expect(isPrivateUrl('http://[::1]/path')).toBe(true);
  });

  it('blocks localhost hostname', () => {
    expect(isPrivateUrl('http://localhost/path')).toBe(true);
  });

  it('blocks localhost with trailing dot', () => {
    expect(isPrivateUrl('http://localhost./test')).toBe(true);
  });

  it('blocks subdomain of localhost (foo.localhost)', () => {
    expect(isPrivateUrl('http://foo.localhost/test')).toBe(true);
  });
});

// ── isPrivateUrl: RFC-1918 private ranges ────────────────────────────────────

describe('isPrivateUrl — RFC-1918 private ranges', () => {
  it('blocks 10.0.0.0/8 (low end)', () => {
    expect(isPrivateUrl('http://10.0.0.1/api')).toBe(true);
  });

  it('blocks 10.255.255.255 (high end of 10/8)', () => {
    expect(isPrivateUrl('http://10.255.255.255/api')).toBe(true);
  });

  it('blocks 192.168.1.1 (private-192)', () => {
    expect(isPrivateUrl('http://192.168.1.1/api')).toBe(true);
  });

  it('blocks 172.16.0.1 (private-172 low boundary)', () => {
    expect(isPrivateUrl('http://172.16.0.1/api')).toBe(true);
  });

  it('blocks 172.31.255.255 (private-172 high boundary)', () => {
    expect(isPrivateUrl('http://172.31.255.255/api')).toBe(true);
  });

  it('allows 172.15.x.x (just below private-172 range)', () => {
    expect(isPrivateUrl('http://172.15.0.1/api')).toBe(false);
  });

  it('allows 172.32.x.x (just above private-172 range)', () => {
    expect(isPrivateUrl('http://172.32.0.1/api')).toBe(false);
  });
});

// ── isPrivateUrl: link-local ──────────────────────────────────────────────────

describe('isPrivateUrl — link-local and cloud metadata', () => {
  it('blocks 169.254.1.1 (link-local)', () => {
    expect(isPrivateUrl('http://169.254.1.1/api')).toBe(true);
  });

  it('blocks 169.254.169.254 (cloud metadata)', () => {
    expect(isPrivateUrl('http://169.254.169.254/latest/meta-data/')).toBe(true);
  });

  it('blocks IPv6 link-local fe80::1', () => {
    expect(isPrivateUrl('http://[fe80::1]/api')).toBe(true);
  });
});

// ── isPrivateUrl: carrier-grade NAT (RFC 6598) ───────────────────────────────

describe('isPrivateUrl — carrier-grade NAT 100.64.0.0/10', () => {
  it('blocks 100.64.0.1 (lower boundary)', () => {
    expect(isPrivateUrl('http://100.64.0.1/')).toBe(true);
  });

  it('blocks 100.127.255.255 (upper boundary)', () => {
    expect(isPrivateUrl('http://100.127.255.255/')).toBe(true);
  });

  it('allows 100.63.255.255 (just below carrier-NAT range)', () => {
    expect(isPrivateUrl('http://100.63.255.255/')).toBe(false);
  });

  it('allows 100.128.0.1 (just above carrier-NAT range)', () => {
    expect(isPrivateUrl('http://100.128.0.1/')).toBe(false);
  });
});

// ── isPrivateUrl: benchmarking range (RFC 2544) ───────────────────────────────

describe('isPrivateUrl — benchmarking range 198.18.0.0/15', () => {
  it('blocks 198.18.0.1', () => {
    expect(isPrivateUrl('http://198.18.0.1/')).toBe(true);
  });

  it('blocks 198.19.255.255', () => {
    expect(isPrivateUrl('http://198.19.255.255/')).toBe(true);
  });

  it('allows 198.20.0.1 (just outside benchmarking range)', () => {
    expect(isPrivateUrl('http://198.20.0.1/')).toBe(false);
  });
});

// ── isPrivateUrl: broadcast / any ────────────────────────────────────────────

describe('isPrivateUrl — broadcast and any address', () => {
  it('blocks 0.0.0.0', () => {
    expect(isPrivateUrl('http://0.0.0.0/')).toBe(true);
  });

  it('blocks 255.255.255.255', () => {
    expect(isPrivateUrl('http://255.255.255.255/')).toBe(true);
  });

  it('blocks multicast 224.0.0.1', () => {
    expect(isPrivateUrl('http://224.0.0.1/')).toBe(true);
  });
});

// ── isPrivateUrl: IPv6 ULA and special ranges ─────────────────────────────────

describe('isPrivateUrl — IPv6 ULA and special addresses', () => {
  it('blocks fc00:: (IPv6 ULA range fc00::/7)', () => {
    expect(isPrivateUrl('http://[fc00::1]/')).toBe(true);
  });

  it('blocks fd00:: (IPv6 ULA range fd00::/8)', () => {
    expect(isPrivateUrl('http://[fd00::1]/')).toBe(true);
  });

  it('blocks :: (IPv6 unspecified)', () => {
    expect(isPrivateUrl('http://[::]/')).toBe(true);
  });

  it('blocks 2001:db8:: (documentation range)', () => {
    expect(isPrivateUrl('http://[2001:db8::1]/')).toBe(true);
  });
});

// ── isPrivateUrl: well-known blocked hostnames ────────────────────────────────

describe('isPrivateUrl — well-known blocked hostnames', () => {
  it('blocks metadata.google.internal', () => {
    expect(isPrivateUrl('http://metadata.google.internal/')).toBe(true);
  });

  it('blocks kubernetes.default.svc', () => {
    expect(isPrivateUrl('http://kubernetes.default.svc/')).toBe(true);
  });

  it('SSRF_BLOCKED_HOSTS contains expected entries', () => {
    expect(SSRF_BLOCKED_HOSTS).toContain('localhost');
    expect(SSRF_BLOCKED_HOSTS).toContain('metadata.google.internal');
    expect(SSRF_BLOCKED_HOSTS).toContain('kubernetes.default.svc');
  });
});

// ── isPrivateUrl: file: URL ───────────────────────────────────────────────────

describe('isPrivateUrl — file: URLs', () => {
  it('blocks file:// URLs', () => {
    expect(isPrivateUrl('file:///etc/passwd')).toBe(true);
  });

  it('blocks file:// URLs on Windows paths', () => {
    expect(isPrivateUrl('file:///C:/Windows/System32/')).toBe(true);
  });
});

// ── isPrivateUrl: allowed public addresses ────────────────────────────────────

describe('isPrivateUrl — allowed public addresses', () => {
  it('allows 1.1.1.1 (Cloudflare DNS)', () => {
    expect(isPrivateUrl('https://1.1.1.1/')).toBe(false);
  });

  it('allows 8.8.8.8 (Google DNS)', () => {
    expect(isPrivateUrl('https://8.8.8.8/')).toBe(false);
  });

  it('allows api.groq.com', () => {
    expect(isPrivateUrl('https://api.groq.com/v1/chat')).toBe(false);
  });

  it('allows runpod API endpoint', () => {
    expect(isPrivateUrl('https://api.runpod.io/graphql')).toBe(false);
  });

  it('allows console.vast.ai', () => {
    expect(isPrivateUrl('https://console.vast.ai/api/v0/')).toBe(false);
  });

  it('returns true for malformed URLs', () => {
    expect(isPrivateUrl('not-a-url')).toBe(true);
  });
});

// ── validateEndpointUrl (sync) ────────────────────────────────────────────────

describe('validateEndpointUrl', () => {
  it('throws for private IPv4 addresses', () => {
    expect(() => validateEndpointUrl('http://10.0.0.1/')).toThrow('SSRF blocked');
  });

  it('throws for loopback', () => {
    expect(() => validateEndpointUrl('http://127.0.0.1/')).toThrow('SSRF blocked');
  });

  it('throws for metadata hostname', () => {
    expect(() => validateEndpointUrl('http://metadata.google.internal/')).toThrow('SSRF blocked');
  });

  it('throws for invalid URL', () => {
    expect(() => validateEndpointUrl('not-a-url')).toThrow('Invalid URL');
  });

  it('does not throw for a public IP', () => {
    expect(() => validateEndpointUrl('https://1.1.1.1/')).not.toThrow();
  });

  it('does not throw for a public hostname', () => {
    expect(() => validateEndpointUrl('https://api.openai.com/v1/chat')).not.toThrow();
  });
});

// ── validateRemoteEndpoint (sync, allows loopback for dev) ───────────────────

describe('validateRemoteEndpoint', () => {
  it('allows localhost (exact loopback dev exemption)', () => {
    expect(() => validateRemoteEndpoint('http://localhost:8000')).not.toThrow();
  });

  it('allows 127.0.0.1 (exact loopback dev exemption)', () => {
    expect(() => validateRemoteEndpoint('http://127.0.0.1:8000')).not.toThrow();
  });

  it('throws for private RFC-1918 address (not the dev exemption)', () => {
    expect(() => validateRemoteEndpoint('http://192.168.1.1:8000')).toThrow('SSRF blocked');
  });

  it('throws for link-local (not loopback)', () => {
    expect(() => validateRemoteEndpoint('http://169.254.169.254/')).toThrow('SSRF blocked');
  });

  it('allows public GPU pod endpoints', () => {
    expect(() => validateRemoteEndpoint('https://gpu-pod.runpod.io:8000')).not.toThrow();
  });

  it('throws for invalid URL', () => {
    expect(() => validateRemoteEndpoint('::bad')).toThrow();
  });
});

// ── validateRemoteEndpointResolved (async, dev loopback allowed) ──────────────

describe('validateRemoteEndpointResolved', () => {
  it('allows localhost without DNS lookup', async () => {
    await expect(validateRemoteEndpointResolved('http://localhost:8000')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows 127.0.0.1 without DNS lookup', async () => {
    await expect(validateRemoteEndpointResolved('http://127.0.0.1:8000')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks hostnames that resolve to private addresses (DNS rebinding)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(validateRemoteEndpointResolved('https://attacker.example.com:8080')).rejects.toThrow(
      'resolves to a private/internal address',
    );
  });

  it('blocks hostnames resolving to link-local (169.254.x.x)', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(validateRemoteEndpointResolved('https://rebind.evil.io/')).rejects.toThrow('resolves to a private');
  });

  it('fails CLOSED when DNS lookup throws (prevents TOCTOU bypass)', async () => {
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(validateRemoteEndpointResolved('https://rebind.example.net:8000')).rejects.toThrow();
  });

  it('allows valid public endpoints (DNS resolves to public IP)', async () => {
    lookupMock.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    await expect(validateRemoteEndpointResolved('https://gpu-pod.runpod.io:8000')).resolves.toBeUndefined();
  });

  it('skips DNS resolution for .test TLD (used in test fixtures)', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(validateRemoteEndpointResolved('https://gpu-pod.test:8000')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('throws for invalid URL', async () => {
    await expect(validateRemoteEndpointResolved('not-a-url')).rejects.toThrow();
  });
});

// ── isPrivateUrlResolved ──────────────────────────────────────────────────────

describe('isPrivateUrlResolved', () => {
  it('returns true for already-private IP (no DNS needed)', async () => {
    await expect(isPrivateUrlResolved('http://10.0.0.1/')).resolves.toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('returns true for hostname resolving to private IP', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.1.1', family: 4 }]);
    await expect(isPrivateUrlResolved('https://attacker.example.com/')).resolves.toBe(true);
  });

  it('returns false for public IP (no DNS needed)', async () => {
    await expect(isPrivateUrlResolved('https://1.1.1.1/')).resolves.toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('returns true for malformed URL', async () => {
    await expect(isPrivateUrlResolved('not-a-url')).resolves.toBe(true);
  });

  it('returns true when DNS throws (fail-closed)', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(isPrivateUrlResolved('https://unknown.example.net/')).resolves.toBe(true);
  });

  it('returns true for file: URL', async () => {
    await expect(isPrivateUrlResolved('file:///etc/passwd')).resolves.toBe(true);
  });
});
