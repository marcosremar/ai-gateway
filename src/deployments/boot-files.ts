import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { DeploymentSpec, FileUrl } from './types';

export const BOOT_FILES_PATH = '/v1/boot-files';
const KEY_INFO = 'aigw-boot-files-v1';

function signature(replicaToken: string, deployment: string, key: string, exp: number): string {
  const signingKey = createHmac('sha256', replicaToken).update(KEY_INFO).digest();
  return createHmac('sha256', signingKey).update(`${deployment}\n${key}\n${exp}`).digest('base64url');
}

export function signedFileUrls(spec: DeploymentSpec, replicaToken: string, publicUrl: string, expSeconds: number): Record<string, FileUrl> {
  const base = publicUrl.replace(/\/+$/, '');
  return Object.fromEntries(Object.entries(spec.files ?? {}).map(([key, b64]) => [key, {
    url: `${base}${BOOT_FILES_PATH}?${new URLSearchParams({ d: spec.name, k: key, exp: String(expSeconds), sig: signature(replicaToken, spec.name, key, expSeconds) })}`,
    sha256: createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'),
  }]));
}

export function filesByUrl(spec: DeploymentSpec, replicaToken: string, publicUrl: string | undefined, nowMs: number): DeploymentSpec {
  if (!publicUrl || !spec.files || !Object.keys(spec.files).length) return spec;
  const exp = Math.ceil(nowMs / 1000) + spec.bootTimeoutMinutes * 60;
  const { files, ...rest } = spec;
  return { ...rest, fileUrls: { ...spec.fileUrls, ...signedFileUrls(spec, replicaToken, publicUrl, exp) } };
}

export interface BootFilesSource {
  specOf(name: string): DeploymentSpec | null;
  bootFilesKeyOf(name: string): string | null;
}

export function bootFile(source: BootFilesSource, query: URLSearchParams, nowMs: number): Buffer | null {
  const deployment = query.get('d') ?? '', key = query.get('k') ?? '', sig = query.get('sig') ?? '';
  const exp = Number(query.get('exp'));
  const token = source.bootFilesKeyOf(deployment);
  if (!token || !Number.isInteger(exp) || exp * 1000 < nowMs) return null;
  const expected = Buffer.from(signature(token, deployment, key, exp));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const files = source.specOf(deployment)?.files;
  const b64 = files && Object.hasOwn(files, key) ? files[key] : undefined;
  return b64 === undefined ? null : Buffer.from(b64, 'base64');
}

export function bootFilesRoute(source: BootFilesSource, now: () => number = Date.now) {
  return {
    method: 'GET', path: BOOT_FILES_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const body = bootFile(source, new URL(req.url ?? '', 'http://x').searchParams, now());
      if (!body) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end('{"error":"not found"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
    },
  };
}
