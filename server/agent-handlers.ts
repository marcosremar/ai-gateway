/**
 * Agent telemetry handlers — recebem heartbeats do aigw_agent.py rodando em
 * cada pod provisionado.
 *
 * Endpoints:
 *   POST /v1/agent/heartbeat   — pod posta telemetria (gpu, mem, disk, log tail)
 *   GET  /v1/agent/state       — gateway expõe a última snapshot recebida (debug/dashboard)
 *
 * Side effect: ao receber um heartbeat com gpu_util > 5%, atualiza
 * lastRequestTime no deploy-state pra que o gpu-idle-logic não mate o pod
 * achando que tá ocioso enquanto na verdade tá processando.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { timingSafeEqual } from 'crypto';
import { createLogger } from '../src/logger';

const log = createLogger('agent-handlers');

interface GpuTelem {
  index: number;
  name: string;
  util_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  temp_c: number;
  power_w: number | null;
}

interface AgentSnapshot {
  pod_id: string;
  ts: number;          // segundos epoch enviados pelo agente
  received_at: number; // ms epoch local do gateway
  uptime_s: number;
  hostname: string;
  /** Número de sessões SSH estabelecidas no pod (reset idle se >0) */
  active_ssh_sessions: number;
  gpus: GpuTelem[];
  memory: { total_bytes: number; available_bytes: number; used_bytes: number; used_pct: number };
  disk: Record<string, { total_bytes: number; free_bytes: number; used_pct: number }>;
  log_tail: string[];
}

const snapshots = new Map<string, AgentSnapshot>();

const TOKEN = process.env.AIGW_AGENT_TOKEN || '';
const STALE_AFTER_MS = 5 * 60_000;
/** Evict snapshots that haven't reported for this long — prevents unbounded
 * map growth from pods that vanish without a clean shutdown. */
const EVICT_AFTER_MS = 60 * 60_000;

function pruneStaleSnapshots(now: number = Date.now()): void {
  for (const [podId, snap] of snapshots) {
    if (now - snap.received_at > EVICT_AFTER_MS) snapshots.delete(podId);
  }
}

function readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function checkAuth(req: IncomingMessage): boolean {
  if (!TOKEN) return true; // unauthenticated mode (dev/local)
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') return false;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const supplied = Buffer.from(match[1].trim(), 'utf8');
  const expected = Buffer.from(TOKEN, 'utf8');
  // Length check first — timingSafeEqual throws on mismatched buffer sizes
  // and a same-length compare alone leaks the secret length anyway.
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

export async function handleAgentHeartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkAuth(req)) {
    jsonResponse(res, 401, { error: 'invalid token' });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (e: any) {
    jsonResponse(res, 413, { error: e?.message || 'body read failed' });
    return;
  }

  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON' });
    return;
  }

  const podId = typeof data.pod_id === 'string' ? data.pod_id : '';
  if (!podId) {
    jsonResponse(res, 400, { error: 'pod_id required' });
    return;
  }

  const snap: AgentSnapshot = {
    pod_id: podId,
    ts: Number(data.ts) || Date.now() / 1000,
    received_at: Date.now(),
    uptime_s: Number(data.uptime_s) || 0,
    hostname: String(data.hostname || ''),
    active_ssh_sessions: Number(data.active_ssh_sessions) || 0,
    gpus: Array.isArray(data.gpus) ? data.gpus.slice(0, 8) : [],
    memory: data.memory || { total_bytes: 0, available_bytes: 0, used_bytes: 0, used_pct: 0 },
    disk: data.disk && typeof data.disk === 'object' ? data.disk : {},
    log_tail: Array.isArray(data.log_tail) ? data.log_tail.slice(-50) : [],
  };
  snapshots.set(podId, snap);
  pruneStaleSnapshots(snap.received_at);

  // Reset idle counter em 3 condições:
  //   1. GPU em uso (util > 5%) — trabalho de inferência ativo
  //   2. Sessão SSH ativa — alguém mexendo no pod (install, debug, manual)
  //   3. Requisições HTTP em vôo no servidor do pod (active_requests)
  // Resolve o bug "idle killed pod ocupado" e evita scale-down durante
  // trabalho humano via SSH.
  const maxUtil = snap.gpus.reduce((m, g) => Math.max(m, g.util_pct || 0), 0);
  const sshActive = Number((data as any).active_ssh_sessions || 0);
  const httpActive = Number((data as any).active_requests || 0);
  if (maxUtil > 5 || sshActive > 0 || httpActive > 0) {
    try {
      const { setLastRequestTime } = require('./state');
      setLastRequestTime(Date.now());
    } catch (e: any) {
      log.warn(`[heartbeat] setLastRequestTime failed: ${e?.message?.slice(0, 80)}`);
    }
  }

  jsonResponse(res, 200, { ok: true, received_at: snap.received_at });
}

export async function handleAgentState(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const now = Date.now();
  const out: Record<string, unknown> = {};
  for (const [podId, snap] of snapshots) {
    const ageMs = now - snap.received_at;
    out[podId] = {
      ...snap,
      age_ms: ageMs,
      stale: ageMs > STALE_AFTER_MS,
    };
  }
  jsonResponse(res, 200, { count: snapshots.size, pods: out });
}

/** Test/internal — limpa snapshots (usado em testes). */
export function _resetAgentSnapshots(): void {
  snapshots.clear();
}

/** Lookup pra outras partes do gateway (idle-logic, dashboards). */
export function getAgentSnapshot(podId: string): AgentSnapshot | undefined {
  return snapshots.get(podId);
}
