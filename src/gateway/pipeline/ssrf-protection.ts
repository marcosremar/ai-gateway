// ── BabelCast Gateway — SSRF Protection ──────────────────────────────────────
// Block fetches to private/internal/metadata IP addresses and hostnames.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Patterns that match private/internal/metadata IP addresses.
 * Compiled once at module load for performance.
 */
export const SSRF_BLOCKED_IP_PATTERNS = [
  { pattern: /^127\./, label: 'localhost' },
  { pattern: /^10\./, label: 'private-10' },
  { pattern: /^192\.168\./, label: 'private-192' },
  { pattern: /^172\.(1[6-9]|2\d|3[01])\./, label: 'private-172' },
  { pattern: /^169\.254\./, label: 'link-local' },
  { pattern: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, label: 'carrier-nat' },
  { pattern: /^198\.(18|19)\./, label: 'benchmarking' },
  { pattern: /^0\.0\.0\.0$/, label: 'any' },
  { pattern: /^255\.255\.255\.255$/, label: 'broadcast' },
  { pattern: /^::1$/i, label: 'ipv6-loopback' },
  { pattern: /^0:0:0:0:0:0:0:1$/i, label: 'ipv6-loopback-expanded' },
  { pattern: /^::$/i, label: 'ipv6-unspecified' },
  { pattern: /^fe80:/i, label: 'ipv6-link-local' },
  { pattern: /^fc[0-9a-f]{2}:/i, label: 'ipv6-ula' },
  { pattern: /^fd[0-9a-f]{2}:/i, label: 'ipv6-ula-c' },
  { pattern: /^2001:db8:/i, label: 'ipv6-documentation' },
  { pattern: /^169\.254\.169\.254$/, label: 'cloud-metadata' },
];

export const SSRF_BLOCKED_HOSTS = [
  'localhost',
  'metadata.google.internal',
  'metadata.google',
  'kubernetes.default.svc',
  'kubernetes.default',
  'etcd-client',
  'etcd.observer',
];

const NORMALIZED_BLOCKED_HOSTS = new Set(SSRF_BLOCKED_HOSTS.map((host) => host.toLowerCase().replace(/\.+$/, '')));
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);
const DNS_SKIP_SUFFIXES = ['.test', '.example', '.invalid'];

/** Only these URL schemes are ever permitted for an outbound fetch (#657).
 *  Everything else — `ftp:`, `gopher:`, `data:`, `file:`, `dict:`, `ws:` … — is
 *  an SSRF / local-read vector and is rejected up front, regardless of host. */
export const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

/** True when the URL's scheme is in the http(s) allowlist. Parse failures and
 *  non-string input fail closed (return false). */
export function isAllowedScheme(urlStr: string): boolean {
  try {
    return ALLOWED_URL_SCHEMES.has(new URL(urlStr).protocol.toLowerCase());
  } catch {
    return false;
  }
}

function normalizeHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/\.+$/, '');

  const mappedIpv4 = normalized.match(/^::ffff:(.+)$/i);
  if (mappedIpv4) {
    const ipv4 = normalizeIpv4LikeHost(mappedIpv4[1]);
    if (ipv4) return ipv4;
  }

  return normalizeIpv4LikeHost(normalized) ?? normalized;
}

function parseIpv4Component(token: string): number | null {
  if (!token) return null;
  if (/^0x[0-9a-f]+$/i.test(token)) return parseInt(token, 16);
  if (/^0[0-7]+$/.test(token)) return parseInt(token, 8);
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return null;
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

function normalizeIpv4LikeHost(host: string): string | null {
  if (!host || host.includes(':')) return null;

  const parts = host.split('.');
  if (parts.length === 1) {
    const value = parseIpv4Component(parts[0]);
    if (value === null || !Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
    return intToIpv4(value);
  }

  if (parts.length > 4) return null;
  const numbers = parts.map(parseIpv4Component);
  if (numbers.some((part) => part === null)) return null;

  const nums = numbers as number[];
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] < 0 || nums[i] > 255) return null;
  }

  const last = nums[nums.length - 1];
  const remainingOctets = 5 - nums.length;
  const lastMax = remainingOctets <= 0 ? 255 : (2 ** (8 * remainingOctets)) - 1;
  if (last < 0 || last > lastMax) return null;

  let value = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    value += nums[i] * (2 ** (8 * (3 - i)));
  }
  value += last;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
  return intToIpv4(value);
}

function isBlockedIpv4(host: string, allowLoopback: boolean): boolean {
  const octets = host.split('.').map((part) => parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;

  const [a, b, c, d] = octets;
  if (!allowLoopback && a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 0) return true;
  if (a >= 224) return true;
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return false;
}

function isBlockedIpv6(host: string, allowLoopback: boolean): boolean {
  const normalized = normalizeHost(host);
  const mappedIpv4 = normalized.match(/^::ffff:(.+)$/i);
  if (mappedIpv4) {
    const ipv4 = normalizeIpv4LikeHost(mappedIpv4[1]);
    return ipv4 ? isBlockedIpv4(ipv4, allowLoopback) : true;
  }

  if (!allowLoopback && (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1')) return true;
  if (normalized === '::') return true;
  if (/^fe80:/i.test(normalized)) return true;
  if (/^fc[0-9a-f]{2}:/i.test(normalized)) return true;
  if (/^fd[0-9a-f]{2}:/i.test(normalized)) return true;
  if (/^2001:db8:/i.test(normalized)) return true;
  return false;
}

function isBlockedHost(host: string, allowLoopback = false): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return true;
  if (normalized.endsWith('.localhost')) return true;
  if (!allowLoopback && NORMALIZED_BLOCKED_HOSTS.has(normalized)) return true;
  if (allowLoopback && LOOPBACK_HOSTS.has(normalized)) return false;

  const family = isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized, allowLoopback);
  if (family === 6) return isBlockedIpv6(normalized, allowLoopback);

  return false;
}

function shouldSkipDnsResolution(host: string, resolveDotless = false): boolean {
  const normalized = normalizeHost(host);
  if (isIP(normalized) !== 0) return true;
  // Single-label hosts (e.g. `etcd`, no dot) normally skip resolution, but a
  // search-domain can still expand them to a private IP (#655). In strict mode
  // we resolve them too; only `.test`/`.example`/`.invalid` stay skipped.
  if (!resolveDotless && !normalized.includes('.')) return true;
  return DNS_SKIP_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

interface ResolveOptions {
  allowLoopback?: boolean;
  /** Block on DNS lookup failure rather than allowing the connect (#659). */
  failClosed?: boolean;
  /** Resolve single-label (dot-less) hostnames too (#655). */
  resolveDotless?: boolean;
}

async function resolvesToBlockedAddress(host: string, opts: boolean | ResolveOptions = false): Promise<boolean> {
  const { allowLoopback = false, failClosed = false, resolveDotless = false } =
    typeof opts === 'boolean' ? { allowLoopback: opts } : opts;
  const normalized = normalizeHost(host);
  if (shouldSkipDnsResolution(normalized, resolveDotless)) return false;
  try {
    const records = await lookup(normalized, { all: true, verbatim: true });
    // An empty record set is suspicious under fail-closed (treat as blocked).
    if (failClosed && records.length === 0) return true;
    return records.some((record) => isBlockedHost(record.address, allowLoopback));
  } catch {
    return failClosed;
  }
}

/** Return true if the URL points to a private/internal/metadata address, or
 *  uses a scheme outside the http(s) allowlist (#657). */
export function isPrivateUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (!ALLOWED_URL_SCHEMES.has(url.protocol.toLowerCase())) return true;
    return isBlockedHost(url.hostname);
  } catch {
    return true;
  }
}

/** Resolve the hostname and return true when it lands on a private/internal address. */
export async function isPrivateUrlResolved(urlStr: string): Promise<boolean> {
  try {
    const url = new URL(urlStr);
    if (!ALLOWED_URL_SCHEMES.has(url.protocol.toLowerCase())) return true;
    if (isBlockedHost(url.hostname)) return true;
    return resolvesToBlockedAddress(url.hostname);
  } catch {
    return true;
  }
}

/** Block fetches to private/internal IP addresses (SSRF protection). Throws on match. */
export function validateEndpointUrl(urlStr: string): void {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }

  // Positive scheme allowlist (#657): reject ftp:/gopher:/data:/file:/… before
  // any host inspection so a non-http(s) scheme can never reach a fetch.
  if (!ALLOWED_URL_SCHEMES.has(url.protocol.toLowerCase())) {
    throw new Error(`SSRF blocked: scheme ${url.protocol} is not allowed (http/https only)`);
  }

  const host = normalizeHost(url.hostname);
  if (NORMALIZED_BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) {
    throw new Error(`SSRF blocked: ${host} is a reserved hostname`);
  }
  if (isBlockedHost(host)) {
    throw new Error(`SSRF blocked: ${host} is a private/internal address`);
  }
}

/** Resolve the hostname and block endpoints that land on private/internal addresses. */
export async function validateEndpointUrlResolved(urlStr: string): Promise<void> {
  validateEndpointUrl(urlStr);
  const url = new URL(urlStr);
  const host = normalizeHost(url.hostname);
  if (await resolvesToBlockedAddress(host)) {
    throw new Error(`SSRF blocked: ${host} resolves to a private/internal address`);
  }
}

/** Strict, fail-closed resolved validator for untrusted URLs (#655, #659).
 *  Unlike {@link validateEndpointUrlResolved} this BLOCKS on a DNS lookup
 *  failure (rather than allowing the connect) and resolves dot-less hostnames
 *  too, closing the search-domain-to-private bypass. Use for any URL that is
 *  influenced by request/config input. */
export async function validateEndpointUrlResolvedStrict(urlStr: string): Promise<void> {
  validateEndpointUrl(urlStr);
  const url = new URL(urlStr);
  const host = normalizeHost(url.hostname);
  if (await resolvesToBlockedAddress(host, { failClosed: true, resolveDotless: true })) {
    throw new Error(`SSRF blocked: ${host} resolves to a private/internal address (or did not resolve)`);
  }
}

/** Validate a GPU/remote endpoint URL, allowing only exact loopback hosts for local dev. */
export function validateRemoteEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid URL: ${endpoint}`);
  }

  const host = normalizeHost(url.hostname);
  if (LOOPBACK_HOSTS.has(host)) return;
  validateEndpointUrl(endpoint);
}

/** Resolve remote endpoint hostnames to prevent DNS-based SSRF bypasses. */
export async function validateRemoteEndpointResolved(endpoint: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid URL: ${endpoint}`);
  }

  const host = normalizeHost(url.hostname);
  if (LOOPBACK_HOSTS.has(host)) return;
  await validateEndpointUrlResolved(endpoint);
}
