/**
 * Fine-tune job records and HTTP-spec normalization.
 *
 * This module owns the durable job state used by the HTTP delivery layer and
 * SDKs. It does not provision GPUs directly; callers still submit work through
 * the Gateway deploy/job path.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { FinetuneOpts } from './types.js';

export type FinetuneJobLifecycle =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FinetuneJobRecord {
  jobId: string;
  userId?: string | null;
  status: FinetuneJobLifecycle;
  spec: Partial<FinetuneOpts>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  specPath: string;
  logPath: string;
  exitPath: string;
  cwd?: string;
  command?: string[];
  instanceId?: string;
  provider?: string;
  gpuType?: string;
  pricePerHr?: number;
  gpuStartedAt?: string;
  sshHost?: string;
  sshPort?: number;
  deployId?: string;
  cleanupStatus?: 'pending' | 'verified' | 'failed' | 'skipped';
  cleanupError?: string;
}

export interface FinetuneHttpStatus {
  jobId: string;
  status: FinetuneJobLifecycle;
  stage: string;
  step?: number;
  totalSteps?: number;
  progressPct?: number;
  bestScore?: number;
  lastScore?: number;
  gateTarget?: number;
  lastEvalStep?: number;
  checkpoints: string[];
  phasesSeen: string[];
  elapsedSec?: number;
  estimatedCostUsd?: number;
  cleanup?: {
    expectedTerminate: boolean;
    status: 'pending' | 'verified' | 'failed' | 'skipped';
    instanceId?: string;
    provider?: string;
    error?: string;
  };
  r2CheckpointUrl?: string;
  hfRepoUrl?: string;
  rawLogs?: string;
  raw: FinetuneJobRecord;
}

export function finetuneJobsRoot(): string {
  return join(homedir(), '.babelcast', 'finetune_jobs');
}

export function safeJobId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}

export function cliJobStatePath(jobId: string): string {
  return join(homedir(), '.babelcast', `last_job-${safeJobId(jobId)}.json`);
}

export function createFinetuneJobRecord(
  spec: Partial<FinetuneOpts>,
  userId?: string | null,
): FinetuneJobRecord {
  const root = finetuneJobsRoot();
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  const jobId = `ft-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const dir = join(root, jobId);
  mkdirSync(dir, { recursive: true });
  const record: FinetuneJobRecord = {
    jobId,
    userId: userId ?? null,
    status: 'queued',
    spec: sanitizeFinetuneSpec(spec) as Partial<FinetuneOpts>,
    createdAt: now,
    updatedAt: now,
    specPath: join(dir, 'spec.json'),
    logPath: join(dir, 'job.log'),
    exitPath: join(dir, 'exit.json'),
  };
  writeFileSync(record.specPath, JSON.stringify(spec, null, 2));
  writeFinetuneJobRecord(record);
  return record;
}

export function finetuneJobRecordPath(jobId: string): string {
  return join(finetuneJobsRoot(), safeJobId(jobId), 'job.json');
}

export function writeFinetuneJobRecord(record: FinetuneJobRecord): void {
  mkdirSync(join(finetuneJobsRoot(), record.jobId), { recursive: true });
  writeFileSync(finetuneJobRecordPath(record.jobId), JSON.stringify({
    ...record,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

export function loadFinetuneJobRecord(jobId: string): FinetuneJobRecord | null {
  const p = finetuneJobRecordPath(jobId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as FinetuneJobRecord;
  } catch {
    return null;
  }
}

export function updateFinetuneJobRecord(
  jobId: string,
  patch: Partial<FinetuneJobRecord>,
): FinetuneJobRecord | null {
  const current = loadFinetuneJobRecord(jobId);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeFinetuneJobRecord(next);
  return next;
}

export function listFinetuneJobRecords(userId?: string | null): FinetuneJobRecord[] {
  const root = finetuneJobsRoot();
  if (!existsSync(root)) return [];
  const records: FinetuneJobRecord[] = [];
  for (const entry of readdirSync(root)) {
    const rec = loadFinetuneJobRecord(entry);
    if (!rec) continue;
    if (userId && rec.userId && rec.userId !== userId) continue;
    records.push(rec);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function loadLatestFinetuneJobRecord(userId?: string | null): FinetuneJobRecord | null {
  const records = listFinetuneJobRecords(userId);
  return records[records.length - 1] ?? null;
}

export function readFinetuneJobLogs(record: FinetuneJobRecord, tail = 0): string {
  if (!existsSync(record.logPath)) return '';
  const text = readFileSync(record.logPath, 'utf-8');
  const sliced = !tail || tail <= 0 ? text : text.split('\n').slice(-tail).join('\n');
  return redactFinetuneText(sliced);
}

export function redactFinetuneText(value: string): string {
  const sensitiveKeys = [
    'HF_TOKEN',
    'HUGGINGFACE_TOKEN',
    'HUGGINGFACE_HUB_TOKEN',
    'HUGGING_FACE_HUB_TOKEN',
    'WANDB_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'CLOUDFLARE_R2_ACCESS_KEY_ID',
    'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    'B2_ACCOUNT_ID',
    'B2_APPLICATION_KEY',
    'B2_APPLICATION_KEY_ID',
    'B2_KEY_ID',
    'STORAGE_ACCESS_KEY',
    'STORAGE_SECRET_KEY',
    'AIGW_APP_KEY',
    'AI_GATEWAY_KEY',
    'GATEWAY_API_KEY',
    'OPENAI_API_KEY',
  ];
  let out = value;
  for (const key of sensitiveKeys) {
    out = out.replace(new RegExp(`\\b(${key})=(['"])[^'"]*\\2`, 'g'), `$1=$2[redacted]$2`);
    out = out.replace(new RegExp(`\\b(${key})=([^\\s;&|]+)`, 'g'), `$1=[redacted]`);
  }
  out = out.replace(/\b(RCLONE_CONFIG_[A-Z0-9_]+_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY))=(['"])[^'"]*\2/g, '$1=$2[redacted]$2');
  out = out.replace(/\b(RCLONE_CONFIG_[A-Z0-9_]+_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY))=([^\s;&|]+)/g, '$1=[redacted]');
  return out.replace(/(Authorization:\s*Bearer\s+)[^\s'"]+/gi, '$1[redacted]');
}

function sanitizeFinetuneSpec(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeFinetuneSpec);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (/(token|secret|password|api[_-]?key|access[_-]?key)/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = sanitizeFinetuneSpec(val);
    }
  }
  return out;
}

export function normalizeFinetuneHttpSpec(body: Record<string, unknown>): Partial<FinetuneOpts> {
  const spec: Record<string, unknown> = { ...body };
  delete spec.gate;
  delete spec.r2;
  delete spec.huggingFace;
  delete spec.ssh;
  delete spec.remoteUrl;
  delete spec.checkpointUrl;

  const gate = isRecord(body.gate) ? body.gate : {};
  if (gate.everySteps !== undefined) spec.evalEverySteps = gate.everySteps;
  if (gate.evalN !== undefined) spec.evalN = gate.evalN;
  if (gate.asrModel !== undefined) spec.evalAsrModel = gate.asrModel;
  if (gate.target !== undefined) spec.evalGateTarget = gate.target;
  if (gate.earlyStopPatience !== undefined) spec.earlyStopPatience = gate.earlyStopPatience;

  const r2 = isRecord(body.r2) ? body.r2 : {};
  if (r2.bucket !== undefined) spec.r2Bucket = r2.bucket;
  if (r2.prefix !== undefined) spec.r2Prefix = r2.prefix;
  if (r2.resume !== undefined) spec.resumeFromR2 = r2.resume;
  if (r2.shardedRoot !== undefined) spec.r2ShardedRoot = r2.shardedRoot;
  if (r2.shardedManifest !== undefined) spec.r2ShardedManifest = r2.shardedManifest;
  if (r2.baseCheckpoint !== undefined) spec.r2BaseCkpt = r2.baseCheckpoint;
  if (r2.baseVocab !== undefined) spec.r2BaseVocab = r2.baseVocab;
  if (r2.checkpointDest !== undefined) spec.r2CkptDest = r2.checkpointDest;
  if (r2.syncIntervalSec !== undefined) spec.r2SyncIntervalSec = r2.syncIntervalSec;
  if (r2.autoResume !== undefined) spec.autoResumeR2 = r2.autoResume;
  if (r2.cacheDir !== undefined) spec.shardCacheDir = r2.cacheDir;
  if (r2.cacheMaxGb !== undefined) spec.shardCacheMaxGb = r2.cacheMaxGb;

  const hf = isRecord(body.huggingFace) ? body.huggingFace : {};
  if (hf.repo !== undefined) {
    spec.pushToHf = hf.repo;
    spec.hfSyncRepo = hf.repo;
  }
  if (hf.path !== undefined) spec.hfSyncPath = hf.path;
  if (hf.intervalSec !== undefined) spec.hfSyncIntervalSec = hf.intervalSec;

  if (!spec.type && !spec.project) spec.type = 'audio';
  return compact(spec) as Partial<FinetuneOpts>;
}

export function deriveFinetuneHttpStatus(
  record: FinetuneJobRecord,
  logs: string,
): FinetuneHttpStatus {
  const lifecycle = inferLifecycle(record, logs);
  const stage = inferStage(lifecycle, logs);
  const { step, totalSteps } = parseStep(logs);
  const lastScore = parseLastNumber(logs, /\b(?:sim_mean|lastScore|score)[=: ]([0-9.]+)/g);
  const bestScore = parseLastNumber(logs, /\b(?:best_sim|best)[=: ]([0-9.]+)/g);
  const lastEvalStep = parseLastNumber(logs, /\beval[^\n]*step[=: ]([0-9]+)/gi);
  const checkpoints = Array.from(new Set(
    Array.from(logs.matchAll(/\b((?:(?:step[-_]|checkpoint[-_]|erinome_step)\d+)[^ \n]*\.(?:pt|safetensors|bin)|model(?:_avg)?\.safetensors)\b/g))
      .map((m) => basename(m[1]))
  )).slice(-20);
  const progressPct = step && totalSteps ? Math.max(0, Math.min(100, (step / totalSteps) * 100)) : undefined;
  const hfRepo = typeof record.spec.hfSyncRepo === 'string' ? record.spec.hfSyncRepo
    : typeof record.spec.pushToHf === 'string' ? record.spec.pushToHf
      : undefined;
  const phasesSeen = inferPhasesSeen(logs, lifecycle);
  const elapsedSec = elapsedSeconds(record);
  const estimatedCostUsd = estimateCost(record, elapsedSec);
  const cleanup = inferCleanup(record, logs);
  const r2CheckpointUrl = typeof record.spec.r2CkptDest === 'string'
    ? record.spec.r2CkptDest
    : typeof record.spec.r2Bucket === 'string'
      ? `${storageRemoteForStatus()}:${record.spec.r2Bucket}/${r2PrefixFor(record.spec)}/checkpoints`
      : undefined;

  return {
    jobId: record.jobId,
    status: lifecycle,
    stage,
    ...(step !== undefined ? { step } : {}),
    ...(totalSteps !== undefined ? { totalSteps } : {}),
    ...(progressPct !== undefined ? { progressPct } : {}),
    ...(bestScore !== undefined ? { bestScore } : {}),
    ...(lastScore !== undefined ? { lastScore } : {}),
    ...(typeof record.spec.evalGateTarget === 'number' ? { gateTarget: record.spec.evalGateTarget } : {}),
    ...(lastEvalStep !== undefined ? { lastEvalStep } : {}),
    checkpoints,
    phasesSeen,
    ...(elapsedSec !== undefined ? { elapsedSec } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(r2CheckpointUrl ? { r2CheckpointUrl } : {}),
    ...(hfRepo ? { hfRepoUrl: `https://huggingface.co/${hfRepo}` } : {}),
    rawLogs: logs,
    raw: record,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined || val === '') continue;
    out[key] = val;
  }
  return out;
}

function inferLifecycle(record: FinetuneJobRecord, logs: string): FinetuneJobLifecycle {
  if (record.status === 'cancelled') return 'cancelled';
  if (record.status === 'completed' || record.status === 'failed') return record.status;
  if (record.exitCode === 0 || /✓ Job completed|job exit code:\s*0/i.test(logs)) return 'completed';
  if (
    typeof record.exitCode === 'number' && record.exitCode !== 0 ||
    /✗ Job failed|Deploy failed|Job error:|preflight failed|spec invalid/i.test(logs)
  ) return 'failed';
  if (/Running job:|step[ =]\d+\/\d+|MILESTONE/i.test(logs)) return 'running';
  if (/Provisioning instance|Waiting for instance ready|Finding cheapest GPU/i.test(logs)) return 'starting';
  return record.status;
}

function inferStage(lifecycle: FinetuneJobLifecycle, logs: string): string {
  if (lifecycle === 'completed') return 'completed';
  if (lifecycle === 'failed') return 'failed';
  if (lifecycle === 'cancelled') return 'cancelled';
  const markers: Array<[string, RegExp]> = [
    ['deploying', /Waiting for instance ready|Provisioning instance/gi],
    ['preparing', /Setting up workspace|preparing|prep|Done:\s+\d+\s+samples/gi],
    ['encoding', /encode|encoded\.pt/gi],
    ['training', /step[ =]\d+\/\d+|Running job:|Starting training|Trainable params|saved .*?\.(?:pt|safetensors|bin)/gi],
    ['smoke-verify', /smoke-verify/gi],
  ];
  let best: { stage: string; at: number } | null = null;
  for (const [stage, re] of markers) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(logs))) {
      if (!best || match.index > best.at) best = { stage, at: match.index };
    }
  }
  return best?.stage ?? lifecycle;
}

function inferPhasesSeen(logs: string, lifecycle: FinetuneJobLifecycle): string[] {
  const phases: Array<[string, RegExp]> = [
    ['deploying', /Waiting for instance ready|Provisioning instance/i],
    ['workspace', /Setting up workspace|uploading|rsync|scp/i],
    ['download', /hf download|\[fine\] dataset cached|\[fine\] model cached/i],
    ['preparing', /preparing|prep|Done:\s+\d+\s+samples/i],
    ['encoding', /encode|encoded\.pt/i],
    ['r2-restore', /\[r2\].*(resume|restaurando|checando checkpoints)/i],
    ['training', /step[ =]\d+\/\d+|Running job:|Starting training|Trainable params/i],
    ['r2-sync', /\[r2\].*(live sync|backup final)/i],
    ['pull-output', /Pulling output|pulled output|rsync.*output/i],
    ['cleanup', /terminated|terminate verification|cleanup/i],
  ];
  const seen = phases.filter(([, re]) => re.test(logs)).map(([phase]) => phase);
  if ((lifecycle === 'completed' || lifecycle === 'failed' || lifecycle === 'cancelled') && !seen.includes(lifecycle)) {
    seen.push(lifecycle);
  }
  return seen;
}

function elapsedSeconds(record: FinetuneJobRecord): number | undefined {
  const start = record.gpuStartedAt || record.startedAt || record.createdAt;
  const end = record.endedAt || new Date().toISOString();
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  return Math.round((endMs - startMs) / 1000);
}

function estimateCost(record: FinetuneJobRecord, elapsedSec: number | undefined): number | undefined {
  if (elapsedSec === undefined || typeof record.pricePerHr !== 'number' || !Number.isFinite(record.pricePerHr)) {
    return undefined;
  }
  return Number(((elapsedSec / 3600) * record.pricePerHr).toFixed(4));
}

function inferCleanup(record: FinetuneJobRecord, logs: string): FinetuneHttpStatus['cleanup'] | undefined {
  const keepAlive = (record.spec as Record<string, unknown>).keepAlive === true;
  const expectedTerminate = !keepAlive;
  let status: 'pending' | 'verified' | 'failed' | 'skipped' = keepAlive ? 'skipped' : 'pending';
  let error = record.cleanupError;
  if (record.cleanupStatus) status = record.cleanupStatus;
  if (/terminated \(verified\)|✓ terminated/i.test(logs)) status = 'verified';
  if (/terminate verification failed|terminate may have failed|cleanup failed/i.test(logs)) {
    status = 'failed';
    error = error || 'termination verification failed';
  }
  if (!record.instanceId && status === 'pending') return undefined;
  return {
    expectedTerminate,
    status,
    ...(record.instanceId ? { instanceId: record.instanceId } : {}),
    ...(record.provider ? { provider: record.provider } : {}),
    ...(error ? { error } : {}),
  };
}

function r2PrefixFor(spec: Partial<FinetuneOpts>): string {
  const raw = typeof spec.r2Prefix === 'string' && spec.r2Prefix
    ? spec.r2Prefix
    : `jobs/${spec.project || spec.type || 'finetune'}`;
  return raw.replace(/^\/+/, '').replace(/\/+$/, '');
}

function storageRemoteForStatus(): string {
  const configured = process.env.AIGW_STORAGE_REMOTE?.trim();
  if (configured) return configured.replace(/:+$/g, '') || 'b2aigw';
  const endpoint = (process.env.B2_ENDPOINT || process.env.R2_ENDPOINT || '').toLowerCase();
  return endpoint.includes('backblazeb2.com') ? 'b2aigw' : 'r2aigw';
}

function parseStep(logs: string): { step?: number; totalSteps?: number } {
  const matches = Array.from(logs.matchAll(/\bstep[ =](\d+)\/(\d+)/g));
  const last = matches[matches.length - 1];
  if (!last) return {};
  return { step: Number(last[1]), totalSteps: Number(last[2]) };
}

function parseLastNumber(logs: string, re: RegExp): number | undefined {
  const matches = Array.from(logs.matchAll(re));
  const last = matches[matches.length - 1];
  if (!last) return undefined;
  const n = Number(last[1]);
  return Number.isFinite(n) ? n : undefined;
}
