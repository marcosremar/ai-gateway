import type { RegistryAuth } from './types';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');
const REGISTRY_TIMEOUT_MS = 10_000;

export interface ImageRef { registry: string; repo: string; reference: string }

export function parseImage(image: string): ImageRef {
  const at = image.indexOf('@');
  const colon = image.lastIndexOf(':');
  const tagged = at < 0 && colon > image.lastIndexOf('/');
  const name = at >= 0 ? image.slice(0, at) : tagged ? image.slice(0, colon) : image;
  const reference = at >= 0 ? image.slice(at + 1) : tagged ? image.slice(colon + 1) : 'latest';
  const first = name.split('/')[0];
  const ownRegistry = name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  const repo = ownRegistry ? name.slice(first.length + 1) : name.includes('/') ? name : `library/${name}`;
  const registry = !ownRegistry || first === 'docker.io' ? 'registry-1.docker.io' : first;
  return { registry, repo, reference };
}

function challengeParams(header: string): Record<string, string> {
  return Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
}

function basic(auth: RegistryAuth): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
}

async function authorization(challenge: string, auth: RegistryAuth | null, fetchImpl: FetchLike): Promise<string | null> {
  if (/^basic/i.test(challenge)) return auth ? basic(auth) : null;
  const { realm, service, scope } = challengeParams(challenge);
  if (!realm) return null;
  const query = new URLSearchParams({ ...(service ? { service } : {}), ...(scope ? { scope } : {}) });
  const res = await fetchImpl(`${realm}?${query}`, {
    headers: auth ? { Authorization: basic(auth) } : {}, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.json() as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  return token ? `Bearer ${token}` : null;
}

export async function missingImage(image: string, auth: RegistryAuth | null, fetchImpl: FetchLike = fetch): Promise<string | null> {
  if (!image.trim()) return null;
  try {
    const { registry, repo, reference } = parseImage(image.trim());
    const url = `https://${registry}/v2/${repo}/manifests/${reference}`;
    const head = (authz: string | null) => fetchImpl(url, {
      method: 'HEAD', headers: { Accept: MANIFEST_ACCEPT, ...(authz ? { Authorization: authz } : {}) }, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    let res = await head(null);
    const challenge = res.status === 401 ? res.headers.get('www-authenticate') : null;
    if (challenge) {
      const authz = await authorization(challenge, auth, fetchImpl);
      if (authz) res = await head(authz);
    }
    return res.status === 404 ? `image ${image} does not exist: ${registry} has no manifest for ${repo}:${reference}` : null;
  } catch {
    return null;
  }
}
