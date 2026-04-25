// ── BabelCast Gateway — Docker Image Manifest Inspection ──────────────────────
// Reads image labels from Docker Hub registry API (no image pull needed).
// Looks for `com.babelcast.*` labels to auto-discover service capabilities.

import { createLogger } from '../src/logger';
import { readJsonBody } from './http-utils';

const log = createLogger('docker-inspect');

export interface BabelcastDockerManifest {
  image: string;
  /** Services declared by the image: 'stt', 'llm', 'tts' */
  services: string[];
  sttModel?: string;
  llmModel?: string;
  ttsModel?: string;
  /** Transport protocol: 'rest' | 'sse' | 'ws' | 'webrtc' */
  protocol: string;
  version?: string;
  /** All raw com.babelcast.* labels */
  rawLabels: Record<string, string>;
}

/** Parse "namespace/name:tag" → { namespace, name, tag } */
function parseImageRef(imageUrl: string): { namespace: string; name: string; tag: string } {
  let ref = imageUrl.trim();
  let tag = 'latest';

  const colonIdx = ref.lastIndexOf(':');
  // Only treat the part after colon as tag if it doesn't look like a port number
  if (colonIdx > 0 && !ref.slice(colonIdx + 1).includes('/')) {
    tag = ref.slice(colonIdx + 1);
    ref = ref.slice(0, colonIdx);
  }

  if (ref.includes('/')) {
    const slashIdx = ref.indexOf('/');
    return { namespace: ref.slice(0, slashIdx), name: ref.slice(slashIdx + 1), tag };
  }
  // Official image (e.g. "nginx") → library/nginx
  return { namespace: 'library', name: ref, tag };
}

async function getRegistryToken(namespace: string, name: string): Promise<string> {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${namespace}/${name}:pull`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json() as { token?: string; access_token?: string };
  const token = data.token ?? data.access_token;
  if (!token) throw new Error('No token in auth response');
  return token;
}

export async function inspectDockerImage(imageUrl: string): Promise<BabelcastDockerManifest> {
  const { namespace, name, tag } = parseImageRef(imageUrl);
  const token = await getRegistryToken(namespace, name);

  // Fetch manifest — prefer v2 schema, fall back to OCI
  const manifestRes = await fetch(
    `https://registry-1.docker.io/v2/${namespace}/${name}/manifests/${tag}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: [
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
        ].join(', '),
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!manifestRes.ok) throw new Error(`Manifest fetch failed: ${manifestRes.status}`);
  const manifest = await manifestRes.json() as {
    config?: { digest: string };
    manifests?: Array<{ digest: string; platform?: { os?: string; architecture?: string } }>;
  };

  // If it's a multi-arch manifest list, pick amd64/linux
  let configDigest: string | undefined = manifest.config?.digest;
  if (!configDigest && manifest.manifests?.length) {
    const amd64 = manifest.manifests.find(m =>
      m.platform?.os === 'linux' && m.platform?.architecture === 'amd64'
    ) ?? manifest.manifests[0];

    // Fetch the platform-specific manifest
    const subRes = await fetch(
      `https://registry-1.docker.io/v2/${namespace}/${name}/manifests/${amd64.digest}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.docker.distribution.manifest.v2+json',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!subRes.ok) throw new Error(`Sub-manifest fetch failed: ${subRes.status}`);
    const sub = await subRes.json() as { config?: { digest: string } };
    configDigest = sub.config?.digest;
  }

  if (!configDigest) throw new Error('Could not locate config digest in manifest');

  // Fetch config blob (contains Labels)
  const blobRes = await fetch(
    `https://registry-1.docker.io/v2/${namespace}/${name}/blobs/${configDigest}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!blobRes.ok) throw new Error(`Config blob fetch failed: ${blobRes.status}`);
  const config = await blobRes.json() as {
    config?: { Labels?: Record<string, string> | null };
  };

  const labels: Record<string, string> = config.config?.Labels ?? {};

  // Extract com.babelcast.* labels
  const bcLabels = Object.fromEntries(
    Object.entries(labels).filter(([k]) => k.startsWith('com.babelcast.'))
  );

  const services = (bcLabels['com.babelcast.services'] ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  return {
    image: imageUrl,
    services,
    sttModel: bcLabels['com.babelcast.stt.model'],
    llmModel: bcLabels['com.babelcast.llm.model'],
    ttsModel: bcLabels['com.babelcast.tts.model'],
    protocol: bcLabels['com.babelcast.protocol'] ?? 'rest',
    version: bcLabels['com.babelcast.version'],
    rawLabels: bcLabels,
  };
}

export async function handleDockerInspect(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let image = url.searchParams.get('image') || '';
  if (!image && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      image = typeof body.image === 'string' ? body.image : '';
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
  }
  if (!image) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing image parameter' }));
    return;
  }
  try {
    const manifest = await inspectDockerImage(image);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed for "${image}": ${msg}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
}
