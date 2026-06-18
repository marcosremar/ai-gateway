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
} from '../../src/gateway/pipeline/ssrf-protection';

afterEach(() => {
  lookupMock.mockReset();
});

describe('SSRF protection hardening', () => {
  it('blocks loopback and private targets written in alternate IP forms', () => {
    expect(isPrivateUrl('http://127.1/test')).toBe(true);
    expect(isPrivateUrl('http://2130706433/test')).toBe(true);
    expect(isPrivateUrl('http://0x7f000001/test')).toBe(true);
    expect(isPrivateUrl('http://0177.0.0.1/test')).toBe(true);
    expect(isPrivateUrl('http://[::ffff:127.0.0.1]/test')).toBe(true);
    expect(isPrivateUrl('http://localhost./test')).toBe(true);
    expect(isPrivateUrl('http://foo.localhost/test')).toBe(true);
  });

  it('allows public endpoints and exact localhost-only dev exemptions', async () => {
    await expect(validateRemoteEndpointResolved('http://localhost:8000')).resolves.toBeUndefined();
    await expect(validateRemoteEndpointResolved('http://127.0.0.1:8000')).resolves.toBeUndefined();
    expect(() => validateRemoteEndpoint('https://api.groq.com')).not.toThrow();
  });

  it('blocks hostnames that resolve to private addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(isPrivateUrlResolved('https://rebind.example.net/meeting')).resolves.toBe(true);
    await expect(validateRemoteEndpointResolved('https://127.0.0.1.nip.io:8000')).rejects.toThrow(
      'resolves to a private/internal address',
    );
  });

  it('skips DNS resolution for reserved test hosts used in fixtures', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(validateRemoteEndpointResolved('https://gpu-pod.test:8000')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('fails CLOSED when DNS resolution errors (no rebinding/TOCTOU bypass)', async () => {
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND rebind.example.net'));

    // An unresolvable host cannot be proven safe — treat it as blocked so an
    // attacker controlling authoritative DNS can't fail the validation lookup
    // and then have fetch() rebind to a private/metadata address.
    await expect(isPrivateUrlResolved('https://rebind.example.net/meeting')).resolves.toBe(true);
    await expect(validateRemoteEndpointResolved('https://rebind.example.net:8000')).rejects.toThrow();
  });
});
