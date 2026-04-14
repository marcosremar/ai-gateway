// ── BabelCast Gateway — SSRF Protection ──────────────────────────────────────
// Block fetches to private/internal/metadata IP addresses.

/** Patterns that match private/internal/metadata IP addresses.
 * Compiled once at module load for performance.
 */
export const SSRF_BLOCKED_IP_PATTERNS = [
  { pattern: /^127\./, label: 'localhost' },
  { pattern: /^10\./, label: 'private-10' },
  { pattern: /^192\.168\./, label: 'private-192' },
  { pattern: /^172\.(1[6-9]|2\d|3[01])\./, label: 'private-172' },
  { pattern: /^169\.254\./, label: 'link-local' },
  { pattern: /^0\.0\.0\.0$/, label: 'any' },
  { pattern: /^::1$/, label: 'ipv6-loopback' },
  { pattern: /^::$/, label: 'ipv6-unspecified' },
  { pattern: /^fe80:/i, label: 'ipv6-link-local' },
  { pattern: /^fc00:/i, label: 'ipv6-ula' },
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

/** Return true if the URL points to a private/internal/metadata address. */
export function isPrivateUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol === 'file:') return true;
    const host = url.hostname.toLowerCase();
    if (SSRF_BLOCKED_HOSTS.includes(host)) return true;
    return SSRF_BLOCKED_IP_PATTERNS.some(({ pattern }) => pattern.test(host));
  } catch { return true; }
}

/** Block fetches to private/internal IP addresses (SSRF protection). Throws on match. */
export function validateEndpointUrl(urlStr: string): void {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  const host = url.hostname.toLowerCase();
  if (SSRF_BLOCKED_HOSTS.includes(host)) {
    throw new Error(`SSRF blocked: ${host} is a reserved hostname`);
  }
  if (SSRF_BLOCKED_IP_PATTERNS.some(({ pattern }) => pattern.test(host))) {
    throw new Error(`SSRF blocked: ${host} is a private/internal address`);
  }
}

/** Validate a GPU/remote endpoint URL, skipping localhost (valid for local dev). */
export function validateRemoteEndpoint(endpoint: string): void {
  if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) return;
  validateEndpointUrl(endpoint);
}
