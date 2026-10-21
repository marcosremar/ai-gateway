/**
 * GPU Warm Pool — stopped-instance pool for <60s time-to-first-inference.
 *
 * Validated live (2026-06-10, docs/gpu-cheap-bughunt-checklist.md): a stopped
 * Vast instance with image+model on disk resumes to first 7B inference in
 * ~11.7s, vs ~105s for a fresh cold deploy. A stopped instance bills storage
 * only, but its GPU returns to the marketplace — another renter can take it
 * (>30s in `scheduling` on resume = likely lost). The pool therefore keeps
 * N>=2 workers on DISTINCT hosts and fails over to the next worker when a
 * resume hangs or the instance vanished.
 *
 * Orchestration goes through this gateway's own HTTP API (loopback) so every
 * call reuses the hardened slot deploy/stop/resume/terminate paths, locks,
 * telemetry and spend accrual. Workers live in deploy slots `warmpool-N`
 * under caller id `warmpool`.
 *
 * Routes (registered in routes/gateway/gpu.ts):
 *   POST /v1/gpu/warmpool/provision — create + warm + stop N workers (202, async)
 *   GET  /v1/gpu/warmpool/status    — pool state (live-checked with ?live=1)
 *   POST /v1/gpu/warmpool/acquire   — resume best worker, verify inference, return endpoint
 *   POST /v1/gpu/warmpool/release   — stop the active worker back into the pool
 *   POST /v1/gpu/warmpool/teardown  — terminate all workers
 */

import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { IncomingMessage, ServerResponse } from 'http';
import { readJsonBody } from './http-utils';
import { PORT } from './config';
import { createLogger } from '../src/logger';

const log = createLogger('gpu-warmpool');

const BABELCAST_DIR = join(homedir(), '.babelcast');
const STATE_FILE = join(BABELCAST_DIR, 'warmpool.json');

const CALLER_ID = 'warmpool';
const PROVISION_TIMEOUT_MS = parseInt(process.env.WARMPOOL_PROVISION_TIMEOUT_MS || '900000', 10); // 15 min/worker
const RESUME_TIMEOUT_MS = parseInt(process.env.WARMPOOL_RESUME_TIMEOUT_MS || '90000', 10); // failover trigger
const VERIFY_TIMEOUT_MS = parseInt(process.env.WARMPOOL_VERIFY_TIMEOUT_MS || '60000', 10);

export interface WarmPoolConfig {
  size: number;
  dockerImage: string;
  gpuTypes: string[];
  maxCostUsd: number;
  minInetDownMbps: number;
  storageGb: number;
  /** Ollama model tag (drives onstart pull + readiness + warmup). */
  model: string;
}

export type WarmWorkerState = 'provisioning' | 'stopped' | 'resuming' | 'active' | 'lost' | 'terminated';

export interface WarmWorker {
  slot: string;
  state: WarmWorkerState;
  model: string;
  createdAt: number;
  deployId?: string;
  instanceId?: string;
  endpoint?: string;
  sshHost?: string;
  gpuType?: string;
  costPerHr?: number;
  /** Last successful resume→verified-inference total, ms. Used to pick the fastest worker first. */
  lastAcquireMs?: number;
  lastError?: string;
}

export interface WarmPoolState {
  config: WarmPoolConfig;
  workers: WarmWorker[];
  provisioning: boolean;
  updatedAt: number;
}

export const DEFAULT_CONFIG: WarmPoolConfig = {
  size: 2,
  dockerImage: 'ollama/ollama:latest',
  gpuTypes: ['RTX 3060', 'RTX 3060 Ti', 'RTX 3070', 'RTX A4000'],
  maxCostUsd: 0.16,
  minInetDownMbps: 500,
  storageGb: 24,
  model: 'qwen2.5:7b',
};

/** Pick the next stopped worker to resume: fastest known acquire first, then oldest. */
export function pickNextWorker(workers: WarmWorker[]): WarmWorker | undefined {
  return workers
    .filter((w) => w.state === 'stopped')
    .sort((a, b) => (a.lastAcquireMs ?? Infinity) - (b.lastAcquireMs ?? Infinity) || a.createdAt - b.createdAt)[0];
}

export function markInterruptedWorkersLost(workers: WarmWorker[]): void {
  for (const w of workers) {
    if (w.state === 'provisioning' || w.state === 'resuming') {
      w.state = 'lost';
      w.lastError = 'interrupted by gateway restart';
    }
  }
}

/** Minimal HTTP transport, injectable for tests. */
export type Transport = (
  method: string,
  path: string,
  body?: unknown,
  opts?: { base?: string; timeoutMs?: number },
) => Promise<{ status: number; json: Record<string, unknown> }>;

function gatewayBase(): string {
  return process.env.WARMPOOL_GATEWAY_URL || `http://127.0.0.1:${PORT}`;
}

const defaultTransport: Transport = async (method, path, body, opts) => {
  const base = opts?.base ?? gatewayBase();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-aigw-user-id': CALLER_ID };
  if (!opts?.base && process.env.GATEWAY_API_KEY) headers['Authorization'] = `Bearer ${process.env.GATEWAY_API_KEY}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
  });
  let json: Record<string, unknown> = {};
  try { json = await res.json() as Record<string, unknown>; } catch { /* non-JSON body */ }
  return { status: res.status, json };
};

function loadState(): WarmPoolState {
  try {
    if (existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as WarmPoolState;
      s.provisioning = false;
      markInterruptedWorkersLost(s.workers ?? []);
      return s;
    }
  } catch (err) {
    log.warn(`Failed to read ${STATE_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { config: DEFAULT_CONFIG, workers: [], provisioning: false, updatedAt: Date.now() };
}

function saveState(state: WarmPoolState): void {
  state.updatedAt = Date.now();
  mkdirSync(BABELCAST_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

export class WarmPool {
  private state: WarmPoolState;
  /** Injected state (tests) stays in memory; default state persists to disk. */
  private persistToDisk: boolean;
  constructor(private http: Transport = defaultTransport, state?: WarmPoolState) {
    this.persistToDisk = !state;
    this.state = state ?? loadState();
  }

  getState(): WarmPoolState { return this.state; }

  private persist(): void {
    if (this.persistToDisk) saveState(this.state);
  }

  private opChain: Promise<unknown> = Promise.resolve();
  private generation = 0;

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.opChain.then(fn, fn);
    this.opChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private ollamaOnstart(model: string): string {
    return `ollama serve & sleep 2; OLLAMA_HOST=127.0.0.1:8000 ollama pull ${model}; wait`;
  }

  /** Provision workers up to config.size. Long-running — call from a background promise. */
  async provision(config: WarmPoolConfig): Promise<void> {
    if (this.state.provisioning) throw new Error('Provision already in progress');
    this.state.config = config;
    this.state.provisioning = true;
    const gen = this.generation;
    this.persist();
    try {
      const alive = this.state.workers.filter((w) => w.state !== 'terminated' && w.state !== 'lost');
      for (let i = alive.length; i < config.size; i++) {
        if (this.generation !== gen) { log.warn('Provision aborted: pool torn down'); break; }
        const slot = `warmpool-${Date.now().toString(36)}-${i}`;
        const worker: WarmWorker = { slot, state: 'provisioning', model: config.model, createdAt: Date.now() };
        this.state.workers.push(worker);
        this.persist();
        try {
          await this.provisionWorker(worker, config);
          if (this.generation !== gen) {
            await this.slotCall('POST', '/v1/gpu/terminate', worker.slot).catch(() => {});
            worker.state = 'terminated';
            this.persist();
            log.warn(`Worker ${slot} terminated: pool torn down during provision`);
            break;
          }
          log.log(`Worker ${slot} provisioned and stopped (host ${worker.sshHost}, ${worker.gpuType})`);
        } catch (err) {
          worker.state = 'lost';
          worker.lastError = err instanceof Error ? err.message : String(err);
          this.persist();
          log.error(`Worker ${slot} provision failed: ${worker.lastError}`);
          // Best-effort cleanup so a half-created instance never bills silently (finding #25).
          await this.slotCall('POST', '/v1/gpu/terminate', worker.slot).catch(() => {});
        }
      }
    } finally {
      this.state.provisioning = false;
      this.persist();
    }
  }

  private async slotCall(method: string, path: string, slot: string, extra?: Record<string, unknown>, timeoutMs?: number) {
    return this.http(method, path, { parallelSlot: slot, ...extra }, { timeoutMs });
  }

  private async provisionWorker(worker: WarmWorker, config: WarmPoolConfig): Promise<void> {
    const usedHosts = new Set(
      this.state.workers.filter((w) => w !== worker && w.sshHost && w.state !== 'terminated' && w.state !== 'lost').map((w) => w.sshHost),
    );
    // One retry if the cheapest offer lands on a host we already use — the pool
    // only survives GPU-reclaim if workers sit on distinct machines.
    for (let attempt = 0; attempt < 2; attempt++) {
      const dep = await this.http('POST', '/v1/gpu/deploy', {
        provider: 'vast',
        dockerImage: config.dockerImage,
        gpuTypes: attempt === 0 ? config.gpuTypes : [...config.gpuTypes].reverse(),
        maxCostUsd: config.maxCostUsd,
        minInetDownMbps: config.minInetDownMbps,
        storageGb: config.storageGb,
        readinessProbe: 'ssh',
        label: `warmpool ${worker.slot}`,
        parallelSlot: worker.slot,
        env: { OLLAMA_HOST: '0.0.0.0:8000', OLLAMA_KEEP_ALIVE: '-1' },
        onstart: this.ollamaOnstart(config.model),
      }, { timeoutMs: 60_000 });
      if (dep.status !== 202 && dep.status !== 200) {
        throw new Error(`deploy rejected (${dep.status}): ${JSON.stringify(dep.json).slice(0, 200)}`);
      }
      worker.deployId = String(dep.json.deployId || '');
      await this.waitForReady(worker);
      if (worker.sshHost && usedHosts.has(worker.sshHost) && attempt === 0) {
        log.warn(`Worker ${worker.slot} landed on duplicate host ${worker.sshHost} — redeploying for host diversity`);
        await this.slotCall('POST', '/v1/gpu/terminate', worker.slot);
        continue;
      }
      break;
    }
    await this.waitForModelAndWarmup(worker);
    const stop = await this.slotCall('POST', '/v1/gpu/stop', worker.slot, {}, 60_000);
    if (stop.status !== 200) throw new Error(`stop failed (${stop.status}): ${JSON.stringify(stop.json).slice(0, 200)}`);
    worker.state = 'stopped';
    this.persist();
  }

  private async waitForReady(worker: WarmWorker): Promise<void> {
    const deadline = Date.now() + PROVISION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { json: s } = await this.http('GET', `/v1/gpu/status?parallelSlot=${worker.slot}`, undefined, { timeoutMs: 15_000 });
      const status = String(s.status || '');
      if (s.podId) worker.instanceId = String(s.podId);
      if (s.endpoint) worker.endpoint = String(s.endpoint);
      if (s.gpuType) worker.gpuType = String(s.gpuType);
      if (typeof s.costPerHr === 'number' && s.costPerHr > 0) worker.costPerHr = s.costPerHr;
      if (worker.endpoint) worker.sshHost = new URL(worker.endpoint).hostname;
      this.persist();
      if (status === 'ready' && worker.endpoint) return;
      if (status === 'error' || status === 'failed') {
        throw new Error(`deploy failed: ${String(s.message || status).slice(0, 200)}`);
      }
      await sleep(3000);
    }
    throw new Error('timeout waiting for worker ready');
  }

  /** Wait until the model is pulled, then absorb the expensive first generation (finding #23) before stopping. */
  private async waitForModelAndWarmup(worker: WarmWorker): Promise<void> {
    if (!worker.endpoint) throw new Error('worker has no endpoint');
    const deadline = Date.now() + PROVISION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { status, json } = await this.http('GET', '/api/tags', undefined, { base: worker.endpoint, timeoutMs: 8_000 }).catch(() => ({ status: 0, json: {} as Record<string, unknown> }));
      if (status === 200) {
        const models = (json.models as Array<{ name?: string }> | undefined)?.map((m) => m.name || '') || [];
        if (models.some((m) => m.includes(worker.model))) break;
      }
      await sleep(3000);
    }
    const gen = await this.http('POST', '/api/generate',
      { model: worker.model, prompt: 'ok', stream: false },
      { base: worker.endpoint, timeoutMs: 120_000 });
    if (gen.status !== 200) throw new Error(`warmup generate failed (${gen.status})`);
  }

  /**
   * Resume the best stopped worker and verify it with a real inference
   * (an HTTP 200 is not enough — ollama accepts requests mid-load, see ollama#15016).
   * Fails over across workers; marks unresponsive ones as lost.
   */
  acquire(): Promise<{ worker: WarmWorker; acquireMs: number; inferenceMs: number }> {
    return this.withLock(() => this._acquire());
  }

  private async _acquire(): Promise<{ worker: WarmWorker; acquireMs: number; inferenceMs: number }> {
    const active = this.state.workers.find((w) => w.state === 'active');
    if (active) return { worker: active, acquireMs: 0, inferenceMs: 0 };

    const tried: string[] = [];
    for (;;) {
      const worker = pickNextWorker(this.state.workers);
      if (!worker) throw new Error(`No stopped workers available (tried: ${tried.join(', ') || 'none'}) — provision or replenish the pool`);
      tried.push(worker.slot);
      const t0 = Date.now();
      worker.state = 'resuming';
      this.persist();
      try {
        const resume = await this.slotCall('POST', '/v1/gpu/resume', worker.slot, {}, RESUME_TIMEOUT_MS);
        if (resume.status !== 200) throw new Error(`resume failed (${resume.status}): ${JSON.stringify(resume.json).slice(0, 150)}`);
        if (!worker.endpoint) {
          const { json: s } = await this.http('GET', `/v1/gpu/status?parallelSlot=${worker.slot}`, undefined, { timeoutMs: 15_000 });
          if (s.endpoint) worker.endpoint = String(s.endpoint);
        }
        if (!worker.endpoint) throw new Error('no endpoint after resume');
        const inf = await this.verifyInference(worker);
        worker.state = 'active';
        worker.lastAcquireMs = Date.now() - t0;
        worker.lastError = undefined;
        this.persist();
        return { worker, acquireMs: worker.lastAcquireMs, inferenceMs: inf };
      } catch (err) {
        // Resume hung (GPU likely re-rented) or instance is gone — fail over.
        worker.state = 'lost';
        worker.lastError = err instanceof Error ? err.message : String(err);
        this.persist();
        log.warn(`Acquire failover: worker ${worker.slot} lost (${worker.lastError}) — trying next`);
      }
    }
  }

  private async verifyInference(worker: WarmWorker): Promise<number> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let lastErr = 'verify timeout';
    while (Date.now() < deadline) {
      const t = Date.now();
      const gen = await this.http('POST', '/api/generate',
        { model: worker.model, prompt: 'ok', stream: false },
        { base: worker.endpoint, timeoutMs: 45_000 }).catch((e) => ({ status: 0, json: { _err: String(e) } as Record<string, unknown> }));
      if (gen.status === 200) return Date.now() - t;
      lastErr = `inference ${gen.status}: ${JSON.stringify(gen.json).slice(0, 120)}`;
      await sleep(1500);
    }
    throw new Error(lastErr);
  }

  /** Stop the active worker back into the pool. */
  release(): Promise<WarmWorker> {
    return this.withLock(() => this._release());
  }

  private async _release(): Promise<WarmWorker> {
    const worker = this.state.workers.find((w) => w.state === 'active');
    if (!worker) throw new Error('No active worker to release');
    const stop = await this.slotCall('POST', '/v1/gpu/stop', worker.slot, {}, 60_000);
    if (stop.status !== 200) throw new Error(`stop failed (${stop.status})`);
    worker.state = 'stopped';
    this.persist();
    return worker;
  }

  /** Terminate every worker and clear the pool. */
  teardown(): Promise<{ terminated: string[] }> {
    return this.withLock(() => this._teardown());
  }

  private async _teardown(): Promise<{ terminated: string[] }> {
    this.generation++;
    const terminated: string[] = [];
    for (const worker of this.state.workers) {
      if (worker.state === 'terminated') continue;
      const r = await this.slotCall('POST', '/v1/gpu/terminate', worker.slot, {}, 60_000).catch(() => ({ status: 0, json: {} }));
      if (r.status === 200 || worker.state === 'lost') {
        worker.state = 'terminated';
        terminated.push(worker.slot);
      }
    }
    this.persist();
    return { terminated };
  }
}

let pool: WarmPool | undefined;
export function getWarmPool(): WarmPool {
  if (!pool) pool = new WarmPool();
  return pool;
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleWarmpoolProvision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown> = {};
  try { body = await readJsonBody(req); } catch { /* defaults */ }
  const config: WarmPoolConfig = { ...DEFAULT_CONFIG, ...(body as Partial<WarmPoolConfig>) };
  if (!Number.isInteger(config.size) || config.size < 1 || config.size > 8) {
    return json(res, 400, { error: 'size must be an integer in [1, 8]' });
  }
  const p = getWarmPool();
  if (p.getState().provisioning) return json(res, 409, { error: 'Provision already in progress' });
  p.provision(config).catch((err) => log.error(`Provision failed: ${err instanceof Error ? err.message : String(err)}`));
  json(res, 202, { ok: true, message: `Provisioning pool of ${config.size} (${config.model}). Poll GET /v1/gpu/warmpool/status.`, config });
}

export async function handleWarmpoolStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  json(res, 200, getWarmPool().getState());
}

export async function handleWarmpoolAcquire(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const t0 = Date.now();
    const r = await getWarmPool().acquire();
    json(res, 200, {
      ok: true,
      endpoint: r.worker.endpoint,
      slot: r.worker.slot,
      gpuType: r.worker.gpuType,
      acquireMs: r.acquireMs,
      inferenceMs: r.inferenceMs,
      totalMs: Date.now() - t0,
    });
  } catch (err) {
    json(res, 503, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleWarmpoolRelease(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const w = await getWarmPool().release();
    json(res, 200, { ok: true, slot: w.slot, state: w.state });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleWarmpoolTeardown(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const r = await getWarmPool().teardown();
    json(res, 200, { ok: true, ...r });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
