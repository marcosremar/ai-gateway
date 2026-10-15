import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { REPORTED_PHASES, type BootEvent, type ReportedPhase } from './boot-track';
import { capLog } from './container-logs';

export const BOOT_EVENTS_PATH = '/v1/boot-events';
export const BOOT_EVENT_MAX_BYTES = 8 * 1024;
export const BOOT_EVENT_LINES = 40;
export const BOOT_EVENT_LINE_CHARS = 300;
export const BOOT_EVENT_TAIL_BYTES = 4000;
const KEY_INFO = 'aigw-boot-events-v1';
const BLOB = /[A-Za-z0-9+/=_-]{120,}/g;

export interface BootReport { url: string; auth: string }

export function bootEventAuth(replicaToken: string): string {
  return createHmac('sha256', replicaToken).update(KEY_INFO).digest('hex');
}

export function sameAuth(given: string, expected: string): boolean {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bootReportFor(publicUrl: string, tokenKey: string, replicaToken: string): BootReport {
  return { url: `${publicUrl.replace(/\/+$/, '')}${BOOT_EVENTS_PATH}?r=${encodeURIComponent(tokenKey)}`, auth: bootEventAuth(replicaToken) };
}

export function parseBootEvent(query: URLSearchParams, text: string, secrets: string[]): BootEvent | null {
  const phase = query.get('phase') as ReportedPhase;
  if (!REPORTED_PHASES.includes(phase)) return null;
  const int = (v: string | null) => (v !== null && /^\d{1,15}$/.test(v) ? Number(v) : null);
  const layers = /^(\d{1,4})\/(\d{1,4})$/.exec(query.get('layers') ?? '');
  const lines = capLog(text.replace(BLOB, '[…]'), secrets).slice(-BOOT_EVENT_LINES).map(l => l.slice(0, BOOT_EVENT_LINE_CHARS));
  return { phase, bytes: int(query.get('bytes')), layers: layers ? [Number(layers[1]), Number(layers[2])] : null, exit: int(query.get('exit')), lines };
}

export interface BootEventSink { bootEvent(key: string, auth: string, query: URLSearchParams, text: string): boolean }

async function readCapped(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BOOT_EVENT_MAX_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function bootEventsRoute(sink: BootEventSink) {
  return {
    method: 'POST', path: BOOT_EVENTS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const reply = (status: number) => { res.writeHead(status, { 'Cache-Control': 'no-store' }); res.end(); };
      if (Number(req.headers['content-length'] ?? 0) > BOOT_EVENT_MAX_BYTES) return reply(413);
      const text = await readCapped(req);
      if (text === null) return reply(413);
      const query = new URL(req.url ?? '', 'http://x').searchParams;
      const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      reply(sink.bootEvent(query.get('r') ?? '', auth, query, text) ? 204 : 401);
    },
  };
}

export function bootReportSetup(report: BootReport, appLog: 'docker' | 'script'): string {
  const app = appLog === 'docker'
    ? `command -v timeout >/dev/null && timeout 5 docker logs --tail 20 app 2>&1 | grep -v 'No such container' | sed 's/^/app: /'`
    : `tail -n 20 /srv/aigw/user-boot.log 2>/dev/null | sed 's/^/app: /'`;
  const q = (v: string) => `'${v.replace(/'/g, `'"'"'`)}'`;
  return `set +x
AIGW_BOOT_URL=${q(report.url)}
AIGW_BOOT_AUTH=${q(report.auth)}
set -x
aigw_tail() { grep -v '^+' /srv/aigw/boot.log 2>/dev/null | tail -n 20; ${app}; }
aigw_report() {
  ( { set +x; } 2>/dev/null; aigw_tail | tail -c ${BOOT_EVENT_TAIL_BYTES} | curl -s -o /dev/null --max-time 3 -X POST -H "Authorization: Bearer $AIGW_BOOT_AUTH" -H 'Content-Type: text/plain' --data-binary @- "$AIGW_BOOT_URL&$1" || true ) </dev/null >/dev/null 2>&1 &
}
aigw_tick() {
  ( { set +x; } 2>/dev/null; c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" || true)
    case "$c" in ''|000) aigw_report phase=starting-container ;; *) aigw_report phase=loading-models ;; esac ) </dev/null >/dev/null 2>&1 &
}
trap 'c=$?; [ -f /srv/aigw/ready.json ] || aigw_report "phase=failed&exit=$c"' EXIT`;
}

export function pullWithProgress(pull: string, image: string): string {
  return `aigw_rx() { awk 'NR > 2 { sub(/:/, " "); if ($1 != "lo") s += $2 } END { printf "%.0f", s }' /proc/net/dev 2>/dev/null || echo 0; }
AIGW_RX0=$(aigw_rx)
aigw_pulled() { echo "bytes=$(( $(aigw_rx) - \${AIGW_RX0:-0} ))&layers=$(grep -c ': Pull complete' /srv/aigw/boot.log 2>/dev/null)/$(grep -cE ': (Pulling fs layer|Already exists)' /srv/aigw/boot.log 2>/dev/null)"; }
( while :; do aigw_report "phase=pulling-image&$(aigw_pulled)"; sleep 20; done ) </dev/null >/dev/null 2>&1 &
AIGW_PULL=$!
${pull}
kill $AIGW_PULL 2>/dev/null
docker image inspect ${image} >/dev/null 2>&1 || aigw_report "phase=failed&exit=$?"
aigw_report "phase=starting-container&$(aigw_pulled)"`;
}
