/**
 * First-boot script of a replica machine. Layout:
 *
 *   :80  nginx (requires `X-Aigw-Token`) ──► 127.0.0.1:8000 ──► container :<port>
 *        /__aigw/ready  → 200 once the container answered its health path (file written by this script)
 *
 * Port 80 because some caller networks only let 80/443 out. The token keeps the machine from being an open
 * model endpoint on the internet; the gateway is the only one that knows it.
 *
 * Safety net: the machine shuts itself down `maxHours` + 30 min after boot. A shut-down Scaleway instance is
 * still billed ("stopped in place"), so the controller deletes halted replicas — the shutdown only bounds the
 * damage if the gateway is gone.
 */

import { packFiles, unpackScript } from './file-pack';
import type { DeploymentSpec } from './types';

/** POSIX single-quote escaping for one shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

export function nginxConfig(token: string): string {
  return `server {
  listen 80 default_server;
  client_max_body_size 100m;
  location = /__aigw/ready {
    if ($http_x_aigw_token != "${token}") { return 401; }
    default_type application/json;
    alias /srv/aigw/ready.json;
  }
  location / {
    if ($http_x_aigw_token != "${token}") { return 401; }
    proxy_set_header X-Aigw-Token "";
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 900;
    proxy_send_timeout 900;
  }
}
`;
}

export function dockerRunCommand(spec: DeploymentSpec): string {
  const parts = [
    'docker run -d --name app --restart unless-stopped --ipc=host',
    spec.gpu ? '--gpus all' : '',
    `-p 127.0.0.1:8000:${spec.port}`,
    '--env-file /srv/aigw/app.env',
    '-v /srv/aigw/data:/data -v /srv/aigw/hf:/root/.cache/huggingface',
    spec.entrypoint ? `--entrypoint ${shellQuote(spec.entrypoint)}` : '',
    shellQuote(spec.image),
    ...spec.args.map(shellQuote),
  ];
  return parts.filter(Boolean).join(' ');
}

/** The pack layout of a spec's files (deterministic: same files → same chunks and index). */
export function packIndexOf(files: Record<string, string>) {
  const pack = packFiles(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))])));
  return { chunkCount: Object.keys(pack.chunks).length, index: pack.index };
}

/** Boot-script mode: the user script runs in the background (it may take long); readiness is still the health loop. */
function bootScriptSection(script: string): string {
  return `echo '${b64(script)}' | base64 -d > /srv/aigw/boot.sh && chmod 700 /srv/aigw/boot.sh
nohup bash /srv/aigw/boot.sh > /srv/aigw/user-boot.log 2>&1 &`;
}

export function replicaCloudInit(spec: DeploymentSpec, token: string): string {
  if (!/^[A-Za-z0-9_-]{24,}$/.test(token)) throw new Error('replica token must be 24+ chars of [A-Za-z0-9_-]');
  const envFile = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const shutdownMinutes = Math.round(spec.maxHours * 60) + 30;
  const bootChecks = Math.max(12, Math.ceil((spec.bootTimeoutMinutes * 60) / 5));
  const login = spec.registryAuth
    ? `echo ${shellQuote(spec.registryAuth.password)} | docker login ${spec.registryAuth.server ? shellQuote(spec.registryAuth.server) + ' ' : ''}`
      + `-u ${shellQuote(spec.registryAuth.username)} --password-stdin`
    : '';
  return `#!/bin/bash
mkdir -p /srv/aigw/data /srv/aigw/hf
exec > >(tee -a /srv/aigw/boot.log) 2>&1
set -x
shutdown -h +${shutdownMinutes}
echo '${b64(nginxConfig(token))}' | base64 -d > /srv/aigw/nginx.conf
echo '${b64(envFile)}' | base64 -d > /srv/aigw/app.env && chmod 600 /srv/aigw/app.env
export DEBIAN_FRONTEND=noninteractive
command -v nginx >/dev/null || { apt-get update -y && apt-get install -y nginx; }
rm -f /etc/nginx/sites-enabled/default
cp /srv/aigw/nginx.conf /etc/nginx/conf.d/aigw.conf && systemctl restart nginx
${spec.files ? unpackScript(packIndexOf(spec.files)) : ''}
${spec.bootScript ? bootScriptSection(spec.bootScript) : `command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
${login}
for i in 1 2 3 4 5; do docker pull ${shellQuote(spec.image)} && break; sleep 15; done
${dockerRunCommand(spec)}`}
for i in $(seq 1 ${bootChecks}); do
  curl -sf -o /dev/null http://127.0.0.1:8000${spec.healthPath} && echo '{"ready":true}' > /srv/aigw/ready.json && break
  sleep 5
done
`;
}
