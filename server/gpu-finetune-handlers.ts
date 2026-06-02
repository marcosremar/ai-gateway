// ── GPU fine-tune HTTP handlers ────────────────────────────────────────────
// Thin delivery layer over src/modules/gpu-finetune job state. Actual GPU
// provisioning still flows through the existing gateway deploy/job CLI path.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createWriteStream, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

import { createLogger } from '../src/logger';
import {
  buildFinetunePlan,
  buildKokoroDatasetPlan,
  loadKokoroDatasetPhrases,
  runKokoroDatasetFanout,
  type KokoroDatasetRequest,
  type KokoroDatasetRunRequest,
} from '../src/modules/gpu-finetune';
import {
  cliJobStatePath,
  createFinetuneJobRecord,
  deriveFinetuneHttpStatus,
  listFinetuneJobRecords,
  loadFinetuneJobRecord,
  loadLatestFinetuneJobRecord,
  normalizeFinetuneHttpSpec,
  readFinetuneJobLogs,
  updateFinetuneJobRecord,
} from '../src/modules/gpu-finetune/jobs';
import { validateSpec } from '../src/modules/gpu-finetune/spec';
import { readJsonBody, handleBodyError, sendJsonError } from './http-utils';
import { readUserIdHeader } from './ws/api-key-resolver';
import { PORT } from './config';

const log = createLogger('gpu-finetune-handlers');
const children = new Map<string, ChildProcess>();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(repoRoot, 'bin/ai-gateway.ts');

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function bearerFromReq(req: IncomingMessage): string {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value) return value.replace(/^Bearer\s+/i, '');
  return bearerFromEnv();
}

function bearerFromEnv(): string {
  const firstMultiKey = process.env.GATEWAY_API_KEYS?.split(',')[0]?.split(':')[0]?.trim();
  return process.env.AIGW_APP_KEY
    || process.env.AI_GATEWAY_KEY
    || process.env.GATEWAY_API_KEY
    || firstMultiKey
    || '';
}

function resolveRequestedJob(req: IncomingMessage): { job: ReturnType<typeof loadFinetuneJobRecord>; userId: string | null } {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const userId = readUserIdHeader(req.headers as Record<string, string | string[] | undefined>);
  const jobId = url.searchParams.get('jobId') || '';
  const job = jobId ? loadFinetuneJobRecord(jobId) : loadLatestFinetuneJobRecord(userId);
  return { job, userId };
}

function isVisibleToCaller(job: NonNullable<ReturnType<typeof loadFinetuneJobRecord>>, userId: string | null): boolean {
  return !userId || !job.userId || job.userId === userId;
}

function refreshRuntimeMetadata(jobId: string): void {
  const statePath = cliJobStatePath(jobId);
  if (!existsSync(statePath)) return;
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    updateFinetuneJobRecord(jobId, {
      instanceId: typeof s.instanceId === 'string' ? s.instanceId : undefined,
      deployId: typeof s.deployId === 'string' ? s.deployId : undefined,
      provider: typeof s.provider === 'string' ? s.provider : undefined,
      gpuType: typeof s.gpuType === 'string' ? s.gpuType : undefined,
      pricePerHr: typeof s.pricePerHr === 'number' ? s.pricePerHr : undefined,
      gpuStartedAt: typeof s.startedAt === 'string' ? s.startedAt : undefined,
      sshHost: typeof s.sshHost === 'string' ? s.sshHost : undefined,
      sshPort: typeof s.sshPort === 'number' ? s.sshPort : undefined,
    });
  } catch {
    // Best effort; the CLI may be writing the state file at the same time.
  }
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function gatewayHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

type KokoroDatasetAction = 'auto' | 'plan' | 'run';

let warnedMissingS3Client = false;

async function createB2HeadObjectProbe() {
  const endpoint = process.env.B2_ENDPOINT || process.env.STORAGE_ENDPOINT || '';
  const region = process.env.B2_REGION || process.env.STORAGE_REGION || 'auto';
  const accessKeyId = process.env.B2_APPLICATION_KEY_ID
    || process.env.B2_KEY_ID
    || process.env.B2_ACCOUNT_ID
    || process.env.STORAGE_ACCESS_KEY
    || '';
  const secretAccessKey = process.env.B2_APPLICATION_KEY || process.env.STORAGE_SECRET_KEY || '';
  if (!endpoint || !accessKeyId || !secretAccessKey) return undefined;

  let s3Module: typeof import('@aws-sdk/client-s3');
  try {
    s3Module = await import('@aws-sdk/client-s3');
  } catch (err) {
    if (!warnedMissingS3Client) {
      warnedMissingS3Client = true;
      log.warn('B2 object-store probe disabled because @aws-sdk/client-s3 is unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  }

  const { S3Client, HeadObjectCommand } = s3Module;
  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return async (bucket: string, key: string) => {
    try {
      const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { ok: true, bytes: res.ContentLength, detail: 'reachable' };
    } catch (err) {
      const e = err as Error & { name?: string };
      return { ok: false, detail: e.name || e.message || 'not reachable' };
    }
  };
}

export async function handleFinetunePlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    handleBodyError(res, err);
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    const includeAgent = body.agent === 'minimax' || body.useAgent === true || url.searchParams.get('agent') === 'minimax';
    let minimax: any;
    if (includeAgent && process.env.MINIMAX_API_KEY) {
      const mod = await import('../src/modules/providers/minimax/index.js');
      minimax = mod.minimaxLLM;
    }
    const plan = await buildFinetunePlan(body as Partial<any>, {
      includeAgent,
      deps: {
        headObject: await createB2HeadObjectProbe(),
        minimax,
      },
    });
    json(res, plan.blockers.length ? 409 : 200, { status: plan.blockers.length ? 'blocked' : 'planned', plan });
  } catch (err) {
    sendJsonError(res, 400, err instanceof Error ? err.message : String(err), 'FINETUNE_PLAN_FAILED');
  }
}

interface KokoroDatasetApiBody {
  action?: KokoroDatasetAction;
  execute?: boolean;
  autoLaunch?: boolean;
  approved?: boolean;
  autoApprove?: boolean;
  yes?: boolean;
  phrases?: number;
  workers?: number;
  maxWorkers?: number;
  voice?: string;
  r2Uri?: string;
  r2?: string;
  speed?: number;
  phraseSource?: 'template' | 'gateway';
  gatewayUrl?: string;
  gatewayKey?: string;
  gatewayModel?: string;
  snapshot?: string;
  autoStopMinutes?: number;
  autoDeleteMinutes?: number;
  timeoutS?: number;
  stallS?: number;
}

export async function handleKokoroDatasetAgentAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    handleBodyError(res, err);
    return;
  }

  const pathAction = routeKokoroDatasetAction(req.url || '');
  const action = pathAction ?? normalizeKokoroDatasetAction(body.action);
  const request = normalizeKokoroDatasetRequest(body);

  let plan;
  try {
    const phrases = await loadKokoroDatasetPhrases(request);
    plan = buildKokoroDatasetPlan(phrases, request);
  } catch (err) {
    sendJsonError(res, 400, err instanceof Error ? err.message : String(err), 'KOKORO_DATASET_PLAN_FAILED');
    return;
  }

  const shouldRun = action === 'run' || (action === 'auto' && (body.execute === true || body.autoLaunch === true));
  if (!shouldRun) {
    json(res, 200, {
      status: 'planned',
      action: 'plan',
      plan,
      nextAction: 'run',
      runEndpoint: '/v1/gpu/finetune/kokoro-dataset/run',
    });
    return;
  }

  const approved = body.yes === true
    || body.approved === true
    || body.autoApprove === true
    || process.env.AIGW_AUTO_APPROVE_CPU_DATASET_PREP === '1';
  if (!approved) {
    sendJsonError(
      res,
      409,
      'CPU dataset prep launch requires approval: set approved:true or AIGW_AUTO_APPROVE_CPU_DATASET_PREP=1',
      'APPROVAL_REQUIRED',
    );
    return;
  }

  try {
    const result = await runKokoroDatasetFanout({
      ...request,
      yes: true,
      maxWorkers: numberOr(body.maxWorkers, undefined),
      snapshot: stringOr(body.snapshot, undefined),
      autoStopMinutes: numberOr(body.autoStopMinutes, undefined),
      autoDeleteMinutes: numberOr(body.autoDeleteMinutes, undefined),
      timeoutS: numberOr(body.timeoutS, undefined),
      stallS: numberOr(body.stallS, undefined),
    });
    json(res, 200, {
      status: 'launched',
      action: 'run',
      plan,
      result,
    });
  } catch (err) {
    sendJsonError(res, 400, err instanceof Error ? err.message : String(err), 'KOKORO_DATASET_RUN_FAILED');
  }
}

function routeKokoroDatasetAction(url: string): KokoroDatasetAction | undefined {
  const pathname = url.split('?')[0] || '';
  if (pathname.endsWith('/plan')) return 'plan';
  if (pathname.endsWith('/run')) return 'run';
  return undefined;
}

function normalizeKokoroDatasetAction(action: unknown): KokoroDatasetAction {
  return action === 'plan' || action === 'run' || action === 'auto' ? action : 'auto';
}

function normalizeKokoroDatasetRequest(body: Record<string, unknown>): KokoroDatasetRequest & KokoroDatasetRunRequest {
  const typed = body as KokoroDatasetApiBody;
  return {
    phrases: numberOr(typed.phrases, undefined),
    workers: numberOr(typed.workers, undefined),
    voice: stringOr(typed.voice, undefined),
    r2Uri: stringOr(typed.r2Uri, stringOr(typed.r2, undefined)),
    speed: numberOr(typed.speed, undefined),
    phraseSource: typed.phraseSource === 'gateway' ? 'gateway' : typed.phraseSource === 'template' ? 'template' : undefined,
    gatewayUrl: stringOr(typed.gatewayUrl, undefined),
    gatewayKey: stringOr(typed.gatewayKey, undefined),
    gatewayModel: stringOr(typed.gatewayModel, undefined),
  };
}

function stringOr(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function numberOr(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

async function listGatewayGpuInstances(token: string): Promise<any[]> {
  const resp = await fetch(`http://127.0.0.1:${PORT}/v1/gpu/list?probe=false`, {
    headers: gatewayHeaders(token),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`list failed HTTP ${resp.status}`);
  const data: any = await resp.json();
  return Array.isArray(data) ? data : (Array.isArray(data.instances) ? data.instances : []);
}

function instanceMatches(inst: any, instanceId: string): boolean {
  return [inst?.instanceId, inst?.podId, inst?.id].filter(Boolean).map(String).includes(String(instanceId));
}

async function waitForGatewayInstanceGone(
  token: string,
  instanceId: string,
  timeoutMs = 90_000,
): Promise<{ verified: boolean; attempts: number; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError = '';
  while (Date.now() < deadline) {
    attempts++;
    try {
      const instances = await listGatewayGpuInstances(token);
      if (!instances.some((inst) => instanceMatches(inst, instanceId))) {
        return { verified: true, attempts };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, attempts <= 3 ? 3000 : 5000));
  }
  return { verified: false, attempts, ...(lastError ? { error: lastError } : {}) };
}

async function terminateFinetuneInstance(jobId: string, token: string): Promise<{
  attempted: boolean;
  ok: boolean;
  verified: boolean;
  error?: string;
}> {
  const statePath = cliJobStatePath(jobId);
  const state = existsSync(statePath)
    ? (() => {
        try { return JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>; }
        catch { return null; }
      })()
    : null;
  const record = loadFinetuneJobRecord(jobId);
  const instanceId = typeof state?.instanceId === 'string' ? state.instanceId : record?.instanceId;
  const deployId = typeof state?.deployId === 'string' ? state.deployId : record?.deployId;
  const provider = typeof state?.provider === 'string' ? state.provider : record?.provider;
  if (!instanceId && !deployId) return { attempted: false, ok: false, verified: false };

  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/v1/gpu/terminate`, {
      method: 'POST',
      headers: gatewayHeaders(token),
      body: JSON.stringify({ instanceId, deployId, provider, force: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return { attempted: true, ok: false, verified: false, error: await resp.text().catch(() => `HTTP ${resp.status}`) };
    }
    if (!instanceId) {
      return { attempted: true, ok: true, verified: true };
    }
    const gone = await waitForGatewayInstanceGone(token, instanceId);
    if (gone.verified) {
      try { unlinkSync(statePath); } catch {}
      updateFinetuneJobRecord(jobId, { cleanupStatus: 'verified', cleanupError: undefined });
    } else {
      updateFinetuneJobRecord(jobId, { cleanupStatus: 'failed', cleanupError: gone.error || 'instance still listed after terminate' });
    }
    return { attempted: true, ok: gone.verified, verified: gone.verified, ...(gone.error && !gone.verified ? { error: gone.error } : {}) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateFinetuneJobRecord(jobId, { cleanupStatus: 'failed', cleanupError: error });
    return { attempted: true, ok: false, verified: false, error };
  }
}

function isTerminalFinetuneStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

async function reconcileFinetuneJobs(): Promise<void> {
  const token = bearerFromEnv();
  const records = listFinetuneJobRecords();
  const activeJobIds = new Set<string>();

  for (const rec of records) {
    refreshRuntimeMetadata(rec.jobId);
    const current = loadFinetuneJobRecord(rec.jobId) || rec;
    const child = children.get(current.jobId);
    const alive = !!child || isPidAlive(current.pid);

    if ((current.status === 'running' || current.status === 'starting' || current.status === 'queued') && alive) {
      activeJobIds.add(current.jobId);
      continue;
    }

    if ((current.status === 'running' || current.status === 'starting') && !alive) {
      updateFinetuneJobRecord(current.jobId, {
        status: 'failed',
        endedAt: current.endedAt || new Date().toISOString(),
        error: current.error || 'runner process exited without status',
      });
    }

    const latest = loadFinetuneJobRecord(current.jobId) || current;
    if (!isTerminalFinetuneStatus(latest.status)) continue;
    if ((latest.spec as Record<string, unknown>).keepAlive === true) continue;
    if (latest.cleanupStatus === 'verified') continue;

    const logs = readFinetuneJobLogs(latest, 200);
    if (/terminated \(verified\)|✓ terminated/i.test(logs)) {
      updateFinetuneJobRecord(latest.jobId, { cleanupStatus: 'verified', cleanupError: undefined });
      continue;
    }
    if (!latest.instanceId && !latest.deployId && !existsSync(cliJobStatePath(latest.jobId))) continue;

    const term = await terminateFinetuneInstance(latest.jobId, token);
    if (term.attempted && !term.ok) {
      log.warn('fine-tune cleanup verification failed', { jobId: latest.jobId, error: term.error });
    }
  }

  if (!token) return;
  try {
    const instances = await listGatewayGpuInstances(token);
    for (const inst of instances) {
      const label = String(inst.label || inst.instanceName || '');
      const match = label.match(/\/job-(ft-[a-zA-Z0-9._-]+)/);
      if (!match) continue;
      const jobId = match[1];
      if (activeJobIds.has(jobId)) continue;
      const rec = loadFinetuneJobRecord(jobId);
      if (rec && !isTerminalFinetuneStatus(rec.status)) continue;
      const instanceId = String(inst.instanceId || inst.podId || '');
      if (!instanceId) continue;
      const resp = await fetch(`http://127.0.0.1:${PORT}/v1/gpu/terminate`, {
        method: 'POST',
        headers: gatewayHeaders(token),
        body: JSON.stringify({ instanceId, provider: inst.provider, force: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        log.warn('fine-tune orphan terminate failed', { jobId, instanceId, status: resp.status });
      }
    }
  } catch (err) {
    log.warn('fine-tune orphan reconciliation failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

let finetuneReconcilerTimer: ReturnType<typeof setInterval> | null = null;

export function startFinetuneReconciler(): void {
  if (finetuneReconcilerTimer) return;
  const intervalMs = Math.max(30_000, Number(process.env.AIGW_FINETUNE_RECONCILE_MS || 60_000));
  const tick = () => {
    reconcileFinetuneJobs().catch((err) => {
      log.warn('fine-tune reconciler failed', { error: err instanceof Error ? err.message : String(err) });
    });
  };
  const initial = setTimeout(tick, 30_000);
  initial.unref?.();
  finetuneReconcilerTimer = setInterval(tick, intervalMs);
  finetuneReconcilerTimer.unref?.();
}

export function stopFinetuneReconciler(): void {
  if (!finetuneReconcilerTimer) return;
  clearInterval(finetuneReconcilerTimer);
  finetuneReconcilerTimer = null;
}

export async function handleStartFinetune(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (err) { handleBodyError(res, err); return; }

  const userId = readUserIdHeader(req.headers as Record<string, string | string[] | undefined>);
  const spec = normalizeFinetuneHttpSpec(body);
  const validation = validateSpec(spec);
  if (!validation.valid) {
    json(res, 400, { error: { message: 'Fine-tune spec invalid', type: 'validation_error' }, errors: validation.errors });
    return;
  }
  const plan = await buildFinetunePlan(spec, { deps: { headObject: await createB2HeadObjectProbe() } });
  if (plan.blockers.length > 0) {
    json(res, 409, {
      error: { message: 'Fine-tune plan blocked before GPU spend', type: 'planning_error' },
      blockers: plan.blockers,
      plan,
    });
    return;
  }

  const job = createFinetuneJobRecord(spec, userId);
  const logStream = createWriteStream(job.logPath, { flags: 'a' });
  const token = bearerFromReq(req);
  const args = [
    'run',
    cliPath,
    'gpu',
    'finetune',
    'submit',
    '--spec',
    job.specPath,
    '--no-estimate',
  ];
  if (body.skipPreflight === true) args.push('--skip-preflight');

  const child = spawn(process.env.BUN_BIN || 'bun', args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      AI_GATEWAY_URL: process.env.AI_GATEWAY_URL || process.env.GATEWAY_URL || `http://127.0.0.1:${PORT}`,
      ...(token ? { AIGW_APP_KEY: token } : {}),
      ...(userId ? { AIGW_APP_NAME: userId, AIGW_OWNER: userId } : {}),
      AIGW_JOB_STATE_ID: job.jobId,
      AIGW_PARALLEL_SLOT: job.jobId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  children.set(job.jobId, child);
  updateFinetuneJobRecord(job.jobId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    pid: child.pid,
    cwd: repoRoot,
    command: ['bun', ...args],
  });

  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  child.on('exit', (code, signal) => {
    children.delete(job.jobId);
    refreshRuntimeMetadata(job.jobId);
    const status = code === 0 ? 'completed' : signal === 'SIGTERM' || signal === 'SIGINT' ? 'cancelled' : 'failed';
    const endedAt = new Date().toISOString();
    updateFinetuneJobRecord(job.jobId, { status, endedAt, exitCode: code, signal });
    try {
      writeFileSync(job.exitPath, JSON.stringify({ code, signal, endedAt }, null, 2));
    } catch {
      // Best effort.
    }
    logStream.end();
  });
  child.on('error', (err) => {
    children.delete(job.jobId);
    updateFinetuneJobRecord(job.jobId, {
      status: 'failed',
      endedAt: new Date().toISOString(),
      error: err.message,
    });
    try { logStream.write(`\n[server] failed to spawn finetune job: ${err.message}\n`); } catch {}
    logStream.end();
  });

  json(res, 202, {
    jobId: job.jobId,
    status: 'running',
    instanceId: '',
    provider: '',
    gpuType: String(spec.gpu ?? ''),
    checkpointPrefix: spec.r2Prefix,
    r2CheckpointUrl: spec.r2CkptDest,
    hfRepoUrl: typeof spec.hfSyncRepo === 'string' ? `https://huggingface.co/${spec.hfSyncRepo}` : undefined,
    message: 'Fine-tune job accepted',
  });
}

export async function handleFinetuneStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { job, userId } = resolveRequestedJob(req);
  if (!job) { json(res, 404, { error: 'Fine-tune job not found', status: 'missing' }); return; }
  if (!isVisibleToCaller(job, userId)) { json(res, 403, { error: 'Fine-tune job belongs to another app' }); return; }

  refreshRuntimeMetadata(job.jobId);
  const current = loadFinetuneJobRecord(job.jobId) || job;
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const tail = Number(url.searchParams.get('tail') || 0);
  const logs = readFinetuneJobLogs(current, Number.isFinite(tail) ? tail : 0);

  if ((current.status === 'running' || current.status === 'starting') && current.pid && !isPidAlive(current.pid)) {
    updateFinetuneJobRecord(current.jobId, { status: 'failed', endedAt: new Date().toISOString(), error: 'runner process exited without status' });
  }

  json(res, 200, deriveFinetuneHttpStatus(loadFinetuneJobRecord(current.jobId) || current, logs));
}

export async function handleFinetuneLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { job, userId } = resolveRequestedJob(req);
  if (!job) { json(res, 404, { error: 'Fine-tune job not found', logs: '' }); return; }
  if (!isVisibleToCaller(job, userId)) { json(res, 403, { error: 'Fine-tune job belongs to another app', logs: '' }); return; }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const tail = Number(url.searchParams.get('tail') || 0);
  json(res, 200, { jobId: job.jobId, logs: readFinetuneJobLogs(job, Number.isFinite(tail) ? tail : 0) });
}

export async function handleCancelFinetune(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (err) { handleBodyError(res, err); return; }

  const userId = readUserIdHeader(req.headers as Record<string, string | string[] | undefined>);
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  const job = jobId ? loadFinetuneJobRecord(jobId) : loadLatestFinetuneJobRecord(userId);
  if (!job) { json(res, 404, { error: 'Fine-tune job not found', cancelled: false }); return; }
  if (!isVisibleToCaller(job, userId)) { json(res, 403, { error: 'Fine-tune job belongs to another app', cancelled: false }); return; }

  const child = children.get(job.jobId);
  if (child && !child.killed) {
    child.kill('SIGTERM');
  } else if (job.pid && isPidAlive(job.pid)) {
    try { process.kill(job.pid, 'SIGTERM'); } catch {}
  }

  const termination = await terminateFinetuneInstance(job.jobId, bearerFromReq(req));
  updateFinetuneJobRecord(job.jobId, {
    status: 'cancelled',
    endedAt: new Date().toISOString(),
    cleanupStatus: termination.verified ? 'verified' : termination.attempted ? 'failed' : 'pending',
    ...(termination.error ? { cleanupError: termination.error } : {}),
  });
  json(res, 200, { jobId: job.jobId, status: 'cancelled', cancelled: true, termination });
}
