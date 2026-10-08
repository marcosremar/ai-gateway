/**
 * First-boot script of a replica machine. Layout:
 *
 *   :80  nginx (requires `X-Aigw-Token`) ──► 127.0.0.1:8000 ──► container :<port>
 *        /__aigw/ready  → 200 once the container answered its health path (file written by this script)
 *        /__aigw/rt/*   → 127.0.0.1:RT_EDGE_PORT, the realtime edge sidecar (`spec.realtime`, docs/realtime-edge.md)
 *
 * Port 80 because some caller networks only let 80/443 out. The token keeps the machine from being an open
 * model endpoint on the internet; the gateway is the only one that knows it.
 *
 * Safety net: the machine shuts itself down `maxHours` + 30 min after boot. A shut-down Scaleway instance is
 * still billed ("stopped in place"), so the controller deletes halted replicas — the shutdown only bounds the
 * damage if the gateway is gone.
 */

import { packFiles, unpackScript } from './file-pack';
import { PROBE_PORT } from './spec';
import type { DeploymentSpec } from './types';

/**
 * The realtime edge (docker/aigw-edge): one generic image for every replica, whatever the GPU or the model image.
 * Built from docker/aigw-edge/Dockerfile; bump the tag when the edge changes.
 */
export const DEFAULT_EDGE_IMAGE = 'ghcr.io/marcosremar/aigw-edge:8c774c6e';
/** The edge's HTTP/WS port on the replica's loopback (nginx proxies `/__aigw/rt/*` to it). */
export const RT_EDGE_PORT = 8020;
/** WebRTC media range when the spec does not set `realtime.udpPorts` (≈ 2 ports per session per worker slice). */
export const DEFAULT_RT_UDP_PORTS: [number, number] = [50000, 50100];
/** Sessions per replica when neither `realtime.maxSessions` nor the machine type's RT_MAX_SESSIONS says. */
export const DEFAULT_RT_MAX_SESSIONS = 8;

/** POSIX single-quote escaping for one shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Per client IP, requests WITHOUT the right token: sustained rate, burst and parallel connections (`nginxConfig`). */
export const UNAUTH_RATE_PER_SECOND = 5;
export const UNAUTH_BURST = 10;
export const UNAUTH_CONNECTIONS = 5;

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/**
 * `listen` is :80 for a gateway-only replica and `PROBE_PORT` for an exposed one (80/443 belong to the app there);
 * `upstream` is the container mapped on 127.0.0.1:8000, or the exposed app's own port.
 */
export function nginxConfig(token: string, listen: number = 80, upstream = 8000, rtPort?: number): string {
  // The upgrade map lets streaming endpoints (e.g. the speech-stack's /ws/audio-stream) pass a WebSocket through
  // the token-gated front; on plain requests $aigw_conn is empty and proxying stays unchanged.
  //
  // Rate limits apply to UNAUTHENTICATED requests only (QA 06/10/2026: a flood of wrong-token requests was never
  // throttled): $aigw_unauth is empty for the right token, and nginx does not count a request whose key is empty. All
  // legitimate traffic comes from the gateway's one egress IP, so limiting by IP without that exemption would throttle
  // a whole class. The token check runs in the ACCESS phase (`auth_request`), after limit_req/limit_conn (PREACCESS):
  // an `if … return 401` runs in the earlier REWRITE phase and would answer before any limit is counted.
  // `server_tokens off` drops the nginx version from headers and error pages.
  return `map $http_upgrade $aigw_conn { default "upgrade"; "" ""; }
map $http_x_aigw_token $aigw_unauth { "${token}" ""; default $binary_remote_addr; }
limit_req_zone $aigw_unauth zone=aigw_unauth:1m rate=${UNAUTH_RATE_PER_SECOND}r/s;
limit_conn_zone $aigw_unauth zone=aigw_unauth_conn:1m;
server_tokens off;
server {
  listen ${listen} default_server;
  client_max_body_size 100m;
  # The realtime WS carries its session token in the URL (up to ~6.5 KB with a 6 KB cfg): above nginx's 8k default line.
  large_client_header_buffers 4 16k;
  limit_req zone=aigw_unauth burst=${UNAUTH_BURST} nodelay;
  limit_conn aigw_unauth_conn ${UNAUTH_CONNECTIONS};
  limit_req_status 429;
  limit_conn_status 429;
  auth_request /__aigw/auth;
  location = /__aigw/auth {
    internal;
    auth_request off;
    if ($http_x_aigw_token != "${token}") { return 401; }
    return 204;
  }
  location = /__aigw/ready {
    default_type application/json;
    alias /srv/aigw/ready.json;
  }
${rtPort ? `  location ^~ /__aigw/rt/ {
    proxy_set_header X-Aigw-Token "";
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $aigw_conn;
    proxy_pass http://127.0.0.1:${rtPort};
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 960;
    proxy_send_timeout 960;
  }
` : ''}  location / {
    proxy_set_header X-Aigw-Token "";
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $aigw_conn;
    proxy_pass http://127.0.0.1:${upstream};
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
    spec.files ? '-v /srv/aigw/files:/files:ro' : '',
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

/** Where the edge reports telemetry; the integrator may pass it, else env `AIGW_PUBLIC_URL` (the gateway's public URL). */
export interface ReplicaInitOptions { gatewayUrl?: string }

/** The edge's static environment (`/srv/aigw/edge.env`; the replica id and public IP are appended at boot). */
export function edgeEnv(spec: DeploymentSpec, token: string, opts: ReplicaInitOptions = {}): Record<string, string> {
  const rt = spec.realtime ?? {};
  const machineEnv = { ...(spec.envByMachineType?.[spec.machineType] ?? {}), ...spec.env };
  const maxSessions = rt.maxSessions ?? (Number(machineEnv.RT_MAX_SESSIONS) || DEFAULT_RT_MAX_SESSIONS);
  const [lo, hi] = rt.udpPorts ?? DEFAULT_RT_UDP_PORTS;
  const upstreamPort = spec.exposure || spec.bootScript ? spec.port : 8000;
  const gatewayUrl = opts.gatewayUrl ?? process.env.AIGW_PUBLIC_URL ?? '';
  return {
    RT_MAX_SESSIONS: String(maxSessions),
    RT_UDP_PORTS: `${lo}-${hi}`,
    RT_PORT: String(RT_EDGE_PORT),
    RT_BIND: '127.0.0.1',
    EDGE_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    AIGW_DEPLOYMENT: spec.name,
    // The edge derives its session key (HMAC-SHA256(token, "aigw-rt-v1")) and telemetry credential from it.
    AIGW_REPLICA_TOKEN: token,
    ...(gatewayUrl ? { GATEWAY_URL: gatewayUrl.replace(/\/$/, '') } : {}),
    ...(machineEnv.RT_SESSIONS_PER_WORKER ? { RT_SESSIONS_PER_WORKER: machineEnv.RT_SESSIONS_PER_WORKER } : {}),
  };
}

/**
 * Starts the edge sidecar (`spec.realtime`): host network (it binds the UDP media range on the machine's own address and
 * 127.0.0.1:RT_EDGE_PORT for nginx), its env file readable by root only, and the two facts only the machine knows —
 * its gateway replica id (`zone:server-id`, the token's `rep` and the telemetry `X-Aigw-Replica`) and its public IPv4
 * (announced in the WebRTC answer) — from the Scaleway metadata service, with the routed interface address as fallback.
 */
function realtimeSection(spec: DeploymentSpec, token: string, opts: ReplicaInitOptions): string {
  const env = Object.entries(edgeEnv(spec, token, opts)).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const image = shellQuote(spec.realtime?.edgeImage ?? DEFAULT_EDGE_IMAGE);
  const meta = `import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
z=d.get("zone") or (d.get("location") or {}).get("zone_id") or ${JSON.stringify(spec.zone)}
ip=(d.get("public_ip") or {}).get("address") or ""
print((z+":"+d["id"]) if d.get("id") else "-", ip or "-")`;
  return `echo '${b64(env)}' | base64 -d > /srv/aigw/edge.env && chmod 600 /srv/aigw/edge.env
META=$(curl -sf --max-time 5 'http://169.254.42.42/conf?format=json' || true)
read -r RID PUB <<< "$(printf '%s' "$META" | python3 -c '${meta.replace(/'/g, `'"'"'`)}' 2>/dev/null)"
[ "$RID" = "-" ] && RID=""; [ "$PUB" = "-" ] && PUB=""
[ -n "$PUB" ] || PUB=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}')
echo "AIGW_REPLICA_ID=$RID" >> /srv/aigw/edge.env && echo "RT_PUBLIC_IP=$PUB" >> /srv/aigw/edge.env
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
for i in 1 2 3 4 5; do docker pull ${image} && break; sleep 10; done
docker rm -f aigw-edge 2>/dev/null; docker run -d --name aigw-edge --restart unless-stopped --network host --env-file /srv/aigw/edge.env ${image}`;
}

/** Boot-script mode: the user script runs in the background (it may take long); readiness is still the health loop. */
function bootScriptSection(script: string): string {
  return `echo '${b64(script)}' | base64 -d > /srv/aigw/boot.sh && chmod 700 /srv/aigw/boot.sh
nohup bash /srv/aigw/boot.sh > /srv/aigw/user-boot.log 2>&1 &`;
}

export function replicaCloudInit(spec: DeploymentSpec, token: string, opts: ReplicaInitOptions = {}): string {
  if (!/^[A-Za-z0-9_-]{24,}$/.test(token)) throw new Error('replica token must be 24+ chars of [A-Za-z0-9_-]');
  // Machine-tuned env (envByMachineType) applies under the explicit env, which always wins — and stays out of
  // spec.env, so changing machineType later re-resolves instead of dragging stale GPU settings along.
  const env = { ...(spec.envByMachineType?.[spec.machineType] ?? {}), ...spec.env };
  const envFile = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const shutdownMinutes = Math.round(spec.maxHours * 60) + 30;
  const bootChecks = Math.max(12, Math.ceil((spec.bootTimeoutMinutes * 60) / 5));
  // Exposed replica: the probe moves to PROBE_PORT and the app answers health on its own port (it owns 80/443).
  const appPort = spec.exposure ? spec.port : 8000;
  const rtPort = spec.realtime ? RT_EDGE_PORT : undefined;
  const nginx = spec.exposure ? nginxConfig(token, PROBE_PORT, appPort, rtPort) : nginxConfig(token, 80, 8000, rtPort);
  const login = spec.registryAuth
    ? `echo ${shellQuote(spec.registryAuth.password)} | docker login ${spec.registryAuth.server ? shellQuote(spec.registryAuth.server) + ' ' : ''}`
      + `-u ${shellQuote(spec.registryAuth.username)} --password-stdin`
    : '';
  return `#!/bin/bash
mkdir -p /srv/aigw/data /srv/aigw/hf
exec > >(tee -a /srv/aigw/boot.log) 2>&1
set -x
shutdown -h +${shutdownMinutes}
echo '${b64(nginx)}' | base64 -d > /srv/aigw/nginx.conf
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
${spec.realtime ? realtimeSection(spec, token, opts) : ''}
for i in $(seq 1 ${bootChecks}); do
  curl -sf -o /dev/null http://127.0.0.1:${appPort}${spec.healthPath} && echo '{"ready":true}' > /srv/aigw/ready.json && break
  sleep 5
done
`;
}

/**
 * Boot script of a Vast replica. Vast runs ONE container per host — no systemd, no Docker-in-Docker — so this is the
 * boot-script mode only, inside the spec's `image` (a public base image) as the instance's onstart:
 *
 *   host :<mapped> ─► container :80 nginx (requires `X-Aigw-Token`) ──► 127.0.0.1:<spec.port> (the boot script's app)
 *
 * The app port is `spec.port` (default 8000), not a fixed 8000: everything shares one container, and a caller's stack
 * may already use 127.0.0.1:8000 for a model server, so its health responder lives on another port (e.g. 8010).
 * nginx is started as a plain daemon (`nginx`, reloaded if already up), never `systemctl`. Safety net: the container
 * stops itself `maxHours + 30 min` after boot (an exited Vast instance bills only its disk; the controller or the reaper
 * deletes it).
 */
export function vastReplicaInit(spec: DeploymentSpec, token: string): string {
  if (!/^[A-Za-z0-9_-]{24,}$/.test(token)) throw new Error('replica token must be 24+ chars of [A-Za-z0-9_-]');
  if (!spec.bootScript) throw new Error('vast replicas run in boot-script mode only');
  const env = { ...(spec.envByMachineType?.[spec.machineType] ?? {}), ...spec.env };
  const envFile = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const stopAfterSeconds = (Math.round(spec.maxHours * 60) + 30) * 60;
  const bootChecks = Math.max(12, Math.ceil((spec.bootTimeoutMinutes * 60) / 5));
  const appPort = spec.port;
  return `#!/bin/bash
mkdir -p /srv/aigw/data /srv/aigw/hf
exec > >(tee -a /srv/aigw/boot.log) 2>&1
set -x
( sleep ${stopAfterSeconds}; kill -TERM 1 ) >/dev/null 2>&1 &
echo '${b64(nginxConfig(token, 80, appPort))}' | base64 -d > /srv/aigw/nginx.conf
echo '${b64(envFile)}' | base64 -d > /srv/aigw/app.env && chmod 600 /srv/aigw/app.env
export DEBIAN_FRONTEND=noninteractive
command -v nginx >/dev/null || { apt-get update -y && apt-get install -y nginx curl; }
mkdir -p /etc/nginx/conf.d && rm -f /etc/nginx/sites-enabled/default
cp /srv/aigw/nginx.conf /etc/nginx/conf.d/aigw.conf
nginx -t && { nginx -s reload 2>/dev/null || nginx; }
${bootScriptSection(spec.bootScript)}
for i in $(seq 1 ${bootChecks}); do
  curl -sf -o /dev/null http://127.0.0.1:${appPort}${spec.healthPath} && echo '{"ready":true}' > /srv/aigw/ready.json && break
  sleep 5
done
`;
}
