/**
 * FinetuneGateway — DI-friendly orchestrator for the finetune pipeline.
 *
 * Single responsibility: given a validated FinetuneOpts, compose the shell
 * script and hand off to the GPU jobs runner. All async side-effects
 * (state read/write, credential lookups) are injected via interfaces.
 *
 * SOLID:
 *   S — FinetuneGateway only composes finetune; it does NOT validate (spec.ts), cost (cost.ts), or probe (status.ts)
 *   O — FinetunePipeline is an interface; FinetuneGateway composes it; swapping pipeline impl requires no changes
 *   L — FinetuneOpts is a simple value object; no inheritance hierarchy
 *   I — Many narrow interfaces: FinetunePipeline, StateStore, CredentialLookup
 *   D — FinetuneGateway takes deps via constructor; caller wires the impl
 */

import { join, dirname, basename, resolve, relative } from 'node:path';
import { statSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { parseProbeOutput, buildStatusResult } from './status.js';

import type {
  FinetuneOpts,
  FinetuneStatusResult,
  FinetuneRunRecord,
  Preset,
  PresetManifest,
  SmokeVerifySpec,
  ProbePathsSpec,
  StageDetectorPatterns,
} from './types.js';
import { BUNDLED_PLUGINS } from './types.js';
import { loadPreset, resolveProjectOpts } from './spec.js';

// ─── Injected interfaces ───────────────────────────────────────────────────

/** Persists finetune run history. */
export interface FinetuneStateStore {
  save(record: FinetuneRunRecord): void;
  loadLast(): FinetuneRunRecord | null;
  loadAll?(): FinetuneRunRecord[];
}

/** Resolves HF token for a user. */
export interface HfTokenResolver {
  resolve(): string;
}

/** Submits a GPU job and returns the instance info. */
export interface GpuJobRunner {
  run(opts: GpuJobRunnerOpts): Promise<GpuJobResult>;
}

export interface GpuJobRunnerOpts {
  path: string;
  main: string;
  gpu: string;
  region?: string;
  maxCost: number;
  maxSpend: number;
  output: string;
  timeoutMin: number;
  bootTimeoutMin?: number;
  bootTimeoutSec?: number;
  raceCount?: number;
  offerRaceCount?: number;
  parallelSlot?: string;
  storageGb?: number;
  image: string;
  provider?: string;        // pin a specific provider (e.g. 'vast') instead of cascade default
  providers?: string[];     // ordered provider allowlist; runner skips entries in cooldown
  preferSpot: boolean;
  reuseInstance: boolean;
  pullEveryMin: number;
  stallMin: number;
  pullExclude: string[];
  abortOnDivergence: boolean;
  gpuFallback: boolean;
  selectMode?: 'cheapest' | 'balanced' | 'fast';
  dryRun?: boolean;
}

export interface GpuJobResult {
  instanceId: string;
  sshHost: string;
  sshPort: number;
  gpuType: string;
  provider: string;
  pricePerHr: number;
  startedAt: string;
}

/** Probes a running finetune instance for status. */
export interface FinetuneProbe {
  probe(meta: GpuJobResult): Promise<string>; // returns raw probe output
}

// ─── In-memory + file-backed state stores ────────────────────────────────

export class InMemoryFinetuneState implements FinetuneStateStore {
  private runs: FinetuneRunRecord[] = [];
  save(record: FinetuneRunRecord): void { this.runs.push(record); }
  loadLast(): FinetuneRunRecord | null { return this.runs[this.runs.length - 1] ?? null; }
  loadAll(): FinetuneRunRecord[] { return [...this.runs]; }
}

/** File-backed state store. Persists each run as `<dir>/<id>.json`. */
export class FileFinetuneState implements FinetuneStateStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  save(record: FinetuneRunRecord): void {
    writeFileSync(join(this.dir, `${record.id}.json`), JSON.stringify(record, null, 2));
  }
  loadAll(): FinetuneRunRecord[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'));
    const records: FinetuneRunRecord[] = [];
    for (const f of files) {
      try {
        records.push(JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as FinetuneRunRecord);
      } catch { /* skip malformed */ }
    }
    records.sort((a, b) => a.ts.localeCompare(b.ts));
    return records;
  }
  loadLast(): FinetuneRunRecord | null {
    const all = this.loadAll();
    return all[all.length - 1] ?? null;
  }
}

export class EnvHfTokenResolver implements HfTokenResolver {
  resolve(): string {
    const cached = `${process.env.HOME}/.cache/huggingface/token`;
    if (process.env.HF_TOKEN) return process.env.HF_TOKEN;
    if (existsSync(cached)) return readFileSync(cached, 'utf-8').trim();
    throw new Error('HF_TOKEN env not set and ~/.cache/huggingface/token missing');
  }
}

// ─── R2 / S3 credential resolution ─────────────────────────────────────────

export interface R2Creds {
  accessKey: string;
  secretKey: string;
  endpoint: string;
  region: string;
  providerKind: 'cloudflare-r2' | 'backblaze-b2' | 's3-compatible';
  providerLabel: string;
  rcloneProvider: 'Cloudflare' | 'Other';
  /** true only when access key, secret key, AND endpoint are all present. */
  hasCreds: boolean;
}

export function detectObjectStorageProvider(endpoint: string): Pick<R2Creds, 'providerKind' | 'providerLabel' | 'rcloneProvider'> {
  if (endpoint.includes('r2.cloudflarestorage.com')) {
    return { providerKind: 'cloudflare-r2', providerLabel: 'Cloudflare R2', rcloneProvider: 'Cloudflare' };
  }
  if (endpoint.includes('backblazeb2.com')) {
    return { providerKind: 'backblaze-b2', providerLabel: 'Backblaze B2', rcloneProvider: 'Other' };
  }
  return { providerKind: 's3-compatible', providerLabel: 'S3-compatible storage', rcloneProvider: 'Other' };
}

/**
 * Resolve durable object-storage credentials from the gateway env. Single source of truth —
 * shared by buildR2Config (run composition) and preflight (fail-fast check).
 * Accepts Backblaze B2 names first, then legacy B2_ACCOUNT_ID/STORAGE_* aliases.
 */
export function resolveR2Creds(env: Record<string, string | undefined> = process.env): R2Creds {
  const accessKey = env.B2_APPLICATION_KEY_ID || env.B2_KEY_ID || env.B2_ACCOUNT_ID || env.STORAGE_ACCESS_KEY || '';
  const secretKey = env.B2_APPLICATION_KEY || env.STORAGE_SECRET_KEY || '';
  const region = env.B2_REGION || env.STORAGE_REGION || 'auto';
  const endpoint = env.B2_ENDPOINT || env.STORAGE_ENDPOINT ||
    ((env.B2_APPLICATION_KEY_ID || env.B2_KEY_ID) && region && region !== 'auto'
      ? `https://s3.${region}.backblazeb2.com`
      : '');
  const provider = detectObjectStorageProvider(endpoint);
  return { accessKey, secretKey, endpoint, region, ...provider, hasCreds: !!(accessKey && secretKey && endpoint) };
}

// ─── FinetuneGateway ───────────────────────────────────────────────────────

export interface GatewayLogger {
  debug(...args: unknown[]): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export class FinetuneGateway {
  constructor(private deps: {
    stateStore: FinetuneStateStore;
    hfToken: HfTokenResolver;
    jobRunner: GpuJobRunner;
    probe: FinetuneProbe;
    log: GatewayLogger;
  }) {}

  /**
   * Build the remote shell script for a finetune run.
   * Exposed so callers can inspect or log it before submission.
   */
  compose(opts: FinetuneOpts): { main: string; resolved: ResolvedFinetune } {
    const resolved = this.resolveOpts(opts);

    const isDir = statSync(resolved.scriptPath).isDirectory();
    const absScript = resolve(resolved.scriptPath);
    const absLocal = resolve(resolved.localPath);
    const scriptRel = isDir
      ? basename(resolved.scriptPath)
      : relative(absLocal, absScript) || basename(resolved.scriptPath);

    const main = this.buildShellScript(resolved, scriptRel);
    return { main, resolved };
  }

  /** Run a finetune: validate → compose → submit. */
  async run(opts: FinetuneOpts): Promise<GpuJobResult> {
    const { main, resolved } = this.compose(opts);

    this.deps.log.log(
      `[finetune] type=${resolved.type}  gpus=${resolved.numGpus}  epochs=${resolved.epochs}  lr=${resolved.lr}`,
    );

    const result = await this.deps.jobRunner.run({
      path: resolved.localPath,
      main,
      gpu: resolved.gpu,
      region: resolved.region,
      maxCost: resolved.maxCost,
      maxSpend: resolved.maxSpend,
      output: resolved.output,
      timeoutMin: resolved.timeoutMin ?? (resolved.smokeOnly ? 30 : 360),
      bootTimeoutSec: resolved.bootTimeoutSec,
      raceCount: resolved.raceCount,
      offerRaceCount: resolved.offerRaceCount,
      parallelSlot: resolved.parallelSlot,
      storageGb: resolved.storageGb,
      image: resolved.image,
      provider: opts.provider ?? (opts.providers?.length === 1 ? opts.providers[0] : undefined),
      providers: opts.provider ? undefined : opts.providers,
      preferSpot: resolved.preferSpot,
      reuseInstance: resolved.reuse,
      pullEveryMin: resolved.pullEveryMin ?? 3,
      stallMin: resolved.stallMin ?? 30,
      bootTimeoutMin: resolved.bootTimeoutMin ?? 10,   // abandon slow/dead instances fast; auto-resubmit picks a new one
      pullExclude: resolved.pullExclude ?? ['data/', 'model/', 'wav/', '*.shard*', '__pycache__/'],
      abortOnDivergence: true,
      gpuFallback: resolved.gpuFallback,
      selectMode: resolved.selectMode,
      dryRun: resolved.dryRun,
    });

    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.deps.stateStore.save({
      id,
      ts: new Date().toISOString(),
      spec: opts,
      instance: result as unknown as Record<string, unknown>,
    });

    return result;
  }

  /** Probe a running finetune and return structured status. */
  async status(jobMeta: GpuJobResult, patterns?: StageDetectorPatterns): Promise<FinetuneStatusResult> {
    const raw = await this.deps.probe.probe(jobMeta);
    const probe = parseProbeOutput(raw);
    return buildStatusResult(probe, {
      instanceId: jobMeta.instanceId,
      gpuType: jobMeta.gpuType,
      provider: jobMeta.provider,
      pricePerHr: jobMeta.pricePerHr,
      startedAt: jobMeta.startedAt,
    }, patterns);
  }

  /** Resolve + normalize options with preset injection. */
  resolveOpts(opts: FinetuneOpts): ResolvedFinetune {
    // Project → merge project defaults + resolve preset name before anything else
    const { opts: mergedOpts } = opts.project ? resolveProjectOpts(opts) : { opts };
    const effectiveOpts = mergedOpts as FinetuneOpts;

    const preset = loadPreset(effectiveOpts.type);
    const resolved: FinetuneOpts = { ...effectiveOpts };

    if (preset) {
      const m = preset.manifest;
      if (!opts.scriptPath) {
        resolved.scriptPath = join(preset.dir, m.trainerScript || 'trainer.py');
        resolved.localPath = preset.dir;
      }
      if (!opts.aptPkgs && m.aptDeps) resolved.aptPkgs = m.aptDeps;
      if (!opts.extraDeps && m.pipDeps) resolved.extraDeps = m.pipDeps;
      if (!opts.model && m.defaultModel) resolved.model = m.defaultModel;
      if (!opts.epochs && m.defaultEpochs) resolved.epochs = m.defaultEpochs;
      if (!opts.lr && m.defaultLR) resolved.lr = m.defaultLR;
      if (!opts.gpu && m.defaultGpu) resolved.gpu = m.defaultGpu;
      if (!opts.maxSpend && m.defaultMaxSpend) resolved.maxSpend = m.defaultMaxSpend;
      if (m.type) resolved.type = m.type;
    }

    if (!existsSync(resolved.scriptPath!)) {
      const candidates = [
        resolved.localPath ? join(resolved.localPath, resolved.scriptPath!) : null,
        resolved.scriptPath,
      ].filter(Boolean) as string[];
      const found = candidates.find(p => existsSync(p!));
      if (!found) throw new Error(`Script not found: tried ${candidates.join(', ')}`);
      resolved.scriptPath = found;
    }

    const isDir = statSync(resolved.scriptPath!).isDirectory();
    resolved.localPath = resolved.localPath || (isDir ? resolved.scriptPath! : dirname(resolved.scriptPath!));

    const out: ResolvedFinetune = {
      ...(resolved as ResolvedFinetune),
      preset,
      smokeOnly: !!resolved.smoke,
      runPreSmoke: !resolved.skipSmoke && !resolved.smoke,
      runSmokeFirst: !resolved.skipSmoke && !resolved.smoke,
      numGpus: resolved.numGpus ?? 1,
      epochs: resolved.epochs ?? 4,
      lr: resolved.lr ?? 5e-5,
      gpu: resolved.gpu ?? '4090',
      maxCost: resolved.maxCost ?? 1.0,
      maxSpend: resolved.maxSpend ?? 10,
      output: resolved.output ?? './output',
      preferSpot: resolved.preferSpot ?? false,
      reuse: resolved.reuse ?? false,
      // Default ON: walk the cheaper-GPU ladder (3090/A4000 before 4090) — a
      // ≤2B QLoRA fits a 3090 (~$0.15/h) vs 4090 (~$0.30/h).
      gpuFallback: resolved.gpuFallback ?? true,
      dryRun: resolved.dryRun ?? false,
      // Registry-qualified so the pod can actually PULL it. A bare
      // 'aigw-finetune-base' has no registry → silently fell back to gpu-dev
      // (no ML deps) → full reinstall every run.
      image: resolved.image ?? 'marcosremar/aigw-finetune-base:latest',
      selectMode: resolved.selectMode ?? 'balanced',
      scriptPath: resolved.scriptPath!,
      localPath: resolved.localPath!,
    };
    return out;
  }

  // ─── Private: shell script builder ─────────────────────────────────────

  buildShellScript(opts: ResolvedFinetune, scriptName: string): string {
    const token = this.resolveHfTokenForRun(opts);
    const exports = this.buildExports(opts, token);
    const r2 = this.buildR2Config(opts);
    const runtimeDiagnostics = this.buildRuntimeDiagnosticsStage(opts, r2);
    const aptStage = this.buildAptStage(opts);
    const pipStage = this.buildPipStage(opts);
    const torchStage = this.buildTorchStage(opts);
    const datasetDl = this.buildDatasetDownload(opts);
    const modelDl = this.buildModelDownload(opts);
    const fromHfStage = this.buildFromHfStage(opts);
    const prepStage = this.buildPrepStage(opts);
    const preSmokeStage = this.buildPreSmokeStage(opts, scriptName);
    const encodeStage = this.buildEncodeStage(opts, scriptName);
    const r2RestoreStage = this.buildR2RestoreStage(opts, r2);
    const trainStage = this.buildTrainStage(opts, scriptName);
    const smokeVerifyInline = this.buildSmokeVerifyInline(opts);
    const ckptAvgStage = this.buildCkptAverageStage(opts);
    const pushStage = this.buildPushStage(opts);
    const r2LiveSyncStart = this.buildR2LiveSyncStart(opts, r2);
    const r2LiveSyncStop = this.buildR2LiveSyncStop(opts, r2);
    const r2BackupStage = this.buildR2BackupStage(opts, r2);
    const webhookStage = this.buildWebhookStage(opts);

    // R2 restore/backup só no run completo (smoke é efêmero, não persiste).
    const pipeline = opts.smokeOnly
      ? `${prepStage}${encodeStage}${trainStage}${smokeVerifyInline}`
      : `${prepStage}${preSmokeStage}${encodeStage}${r2RestoreStage}${r2LiveSyncStart}${trainStage}${r2LiveSyncStop}${ckptAvgStage}${pushStage}${r2BackupStage}${webhookStage}`;

    // Overlap pip install with dataset/model download to save ~2min per run.
    // pip runs in background; dataset + model download in foreground; then we wait for pip.
    // If pip fails, `wait $__PIP` returns non-zero and set -e kills the job.
    const hasDl = datasetDl || modelDl || fromHfStage;
    let installBlock: string;
    if (hasDl && (pipStage || torchStage)) {
      const pipFull = [torchStage, pipStage].filter(Boolean).join(' && ');
      // Launch pip in background before downloads, join after. Keep the
      // background operator inside a grouped command; otherwise shell `&& ... &`
      // backgrounds the whole previous AND-list, including the env exports.
      installBlock = `( { ${pipFull}; } > /tmp/pip.log 2>&1 & __PIP=$!; ` +
        `${datasetDl}${modelDl}${fromHfStage}true; ` +
        `wait $__PIP || { cat /tmp/pip.log; exit 1; } )`;
    } else {
      installBlock = [torchStage, pipStage, `${datasetDl}${modelDl}${fromHfStage}true`].filter(Boolean).join(' && ');
    }

    return [
      'set -euo pipefail',
      token ? `export HF_TOKEN=${shellQuote(token)}` : '',
      ...exports,
      ...(r2?.exports ?? []),
      `export ${opts.noHfTransfer ? '' : 'HF_XET_HIGH_PERFORMANCE=1 HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50 '}HF_HUB_DOWNLOAD_TIMEOUT=30 HF_HUB_ETAG_TIMEOUT=30 DEBIAN_FRONTEND=noninteractive`,
      'cd /workspace',
      runtimeDiagnostics,
      aptStage,
      installBlock,
      'mkdir -p /workspace/checkpoints',
      pipeline,
    ].filter(Boolean).join(' && ');
  }

  private needsHfToken(opts: ResolvedFinetune): boolean {
    return Boolean(
      opts.dataset ||
      opts.model ||
      opts.pushToHf ||
      opts.hfBase ||
      opts.fromHf ||
      opts.hfSyncRepo
    );
  }

  private resolveHfTokenForRun(opts: ResolvedFinetune): string {
    if (!this.needsHfToken(opts)) return '';
    try {
      return this.deps.hfToken.resolve();
    } catch (err) {
      if (opts.dryRun) return '[dry-run-hf-token]';
      throw err;
    }
  }

  // ─── Stage builders ────────────────────────────────────────────────────

  private buildExports(opts: ResolvedFinetune, _token: string): string[] {
    const { wandb, secrets, hfBase, hfStructure, pushToHf } = opts;
    const hfStructureVal = hfStructure || (hfBase ? 'split' : 'flat');
    const hfWeights = hfBase || pushToHf;
    const hfDataset = hfBase && hfStructureVal !== 'flat' ? `${hfBase}-dataset` : '';
    const hfCode = hfBase && hfStructureVal === 'tri' ? `${hfBase}-code` : '';

    const livePushExports = [
      hfWeights ? `export IARATTS_HF_WEIGHTS_REPO=${shellQuote(hfWeights)}` : '',
      hfDataset ? `export IARATTS_HF_DATASET_REPO=${shellQuote(hfDataset)}` : '',
      hfCode ? `export IARATTS_HF_CODE_REPO=${shellQuote(hfCode)}` : '',
    ].filter(Boolean);

    const wandbExports = wandb
      ? [
          `export WANDB_PROJECT=${shellQuote(wandb.project)}`,
          wandb.entity ? `export WANDB_ENTITY=${shellQuote(wandb.entity)}` : '',
          wandb.runName ? `export WANDB_RUN_NAME=${shellQuote(wandb.runName)}` : '',
          wandb.logModel ? `export WANDB_LOG_MODEL=${shellQuote(wandb.logModel)}` : '',
          process.env.WANDB_API_KEY ? `export WANDB_API_KEY=${shellQuote(process.env.WANDB_API_KEY)}` : '',
        ].filter(Boolean)
      : [];

    const secretExports = secrets
      ? Object.entries(secrets).map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      : [];

    const route2Exports = [
      opts.r2ShardedRoot ? `export R2_SHARDED_ROOT=${shellQuote(opts.r2ShardedRoot)}` : '',
      opts.r2ShardedManifest ? `export R2_SHARDED_MANIFEST=${shellQuote(opts.r2ShardedManifest)}` : '',
      opts.r2BaseCkpt ? `export R2_BASE_CKPT=${shellQuote(opts.r2BaseCkpt)}` : '',
      opts.r2BaseVocab ? `export R2_BASE_VOCAB=${shellQuote(opts.r2BaseVocab)}` : '',
      opts.r2CkptDest ? `export R2_CKPT_DEST=${shellQuote(opts.r2CkptDest)}` : '',
      opts.shardCacheDir ? `export SHARD_CACHE_DIR=${shellQuote(opts.shardCacheDir)}` : '',
      opts.shardCacheMaxGb !== undefined ? `export SHARD_CACHE_MAX_GB=${shellQuote(String(opts.shardCacheMaxGb))}` : '',
      opts.steps !== undefined ? `export ROUTE2_STEPS=${shellQuote(String(opts.steps))}` : '',
      `export ROUTE2_BATCH=${shellQuote(String(opts.batchSize ?? 32))}`,
      `export ROUTE2_LR=${shellQuote(String(opts.lr))}`,
      `export ROUTE2_WORKERS=${shellQuote(String(opts.workers ?? 2))}`,
      `export ROUTE2_SAVE_EVERY=${shellQuote(String(opts.saveEverySteps ?? 500))}`,
      `export ROUTE2_LOG_EVERY=${shellQuote(String(opts.logEverySteps ?? 20))}`,
      `export ROUTE2_EVAL_EVERY=${shellQuote(String(opts.evalEverySteps ?? 1000))}`,
      `export ROUTE2_EVAL_N=${shellQuote(String(opts.evalN ?? 8))}`,
      `export ROUTE2_WHISPER=${shellQuote(opts.evalAsrModel ?? 'base')}`,
      `export ROUTE2_PATIENCE=${shellQuote(String(opts.earlyStopPatience ?? 4))}`,
      opts.evalGateTarget !== undefined ? `export ROUTE2_GATE_TARGET=${shellQuote(String(opts.evalGateTarget))}` : '',
      opts.hfSyncRepo ? `export HF_SYNC_REPO=${shellQuote(opts.hfSyncRepo)}` : '',
      opts.hfSyncPath ? `export HF_SYNC_PATH=${shellQuote(opts.hfSyncPath)}` : '',
      opts.hfSyncIntervalSec !== undefined ? `export HF_SYNC_INTERVAL_SEC=${shellQuote(String(opts.hfSyncIntervalSec))}` : '',
      opts.r2Bucket ? `export AIGW_CHECKPOINT_DIR=/workspace/checkpoints` : '',
      opts.r2Bucket ? `export AIGW_R2_AUTO_RESUME=${shellQuote(String(opts.autoResumeR2 !== false))}` : '',
      opts.r2Bucket ? `export AIGW_R2_SYNC_INTERVAL_SEC=${shellQuote(String(opts.r2SyncIntervalSec ?? 180))}` : '',
    ].filter(Boolean);

    return [...livePushExports, ...wandbExports, ...secretExports, ...route2Exports];
  }

  private buildAptStage(opts: ResolvedFinetune): string {
    const aptByType: Record<string, string> = {
      text: 'build-essential',
      audio: 'build-essential libsndfile1 ffmpeg',
      custom: 'build-essential',
    };
    const apt = `${aptByType[opts.type] || 'pkg-config build-essential'}${opts.aptPkgs ? ' ' + opts.aptPkgs : ''}`;
    return `${this.aptWait()} && apt-get update -q && apt-get install -y -q ${apt}`;
  }

  private buildPipStage(opts: ResolvedFinetune): string {
    const pipByType: Record<string, string> = {
      text: '"huggingface-hub>=1.0.0" hf_transfer torch transformers datasets accelerate safetensors',
      audio: '"huggingface-hub>=1.0.0" hf_transfer torch torchaudio safetensors soundfile',
      custom: '"huggingface-hub>=1.0.0" hf_transfer torch safetensors',
    };
    const pluginData = opts.plugin ? BUNDLED_PLUGINS[opts.plugin] : undefined;
    const pip = `${pipByType[opts.type] || pipByType.custom}` +
      `${opts.extraDeps ? ' ' + opts.extraDeps : ''}` +
      `${pluginData?.extraDeps ? ' ' + pluginData.extraDeps : ''}`;
    return `pip install --quiet --prefer-binary ${pip}`;
  }

  private buildTorchStage(opts: ResolvedFinetune): string {
    const m = opts.preset?.manifest;
    if (!m?.torchVersion || !m?.torchCudaIndex) return '';
    return `pip install torch==${m.torchVersion} torchaudio==${m.torchVersion} --index-url ${m.torchCudaIndex}`;
  }

  private buildDatasetDownload(opts: ResolvedFinetune): string {
    if (!opts.dataset?.startsWith('hf://')) return '';
    const dsInclude = opts.datasetInclude
      ? opts.datasetInclude.split(',').map(p => ` --include "${p.trim()}"`).join('')
      : '';
    return `if [ ! -d /root/data ] || [ -z "$(ls /root/data 2>/dev/null)" ]; then ` +
      `hf download ${opts.dataset.slice(5)} --repo-type dataset --local-dir /root/data --token "$HF_TOKEN"${dsInclude}; ` +
      `else echo '[fine] dataset cached'; fi && `;
  }

  private buildModelDownload(opts: ResolvedFinetune): string {
    if (!opts.model?.startsWith('hf://')) return '';
    return `if [ ! -d /root/model ] || [ -z "$(ls /root/model 2>/dev/null)" ]; then ` +
      `hf download ${opts.model.slice(5)} --local-dir /root/model --token "$HF_TOKEN"; ` +
      `else echo '[fine] model cached'; fi && `;
  }

  private buildFromHfStage(opts: ResolvedFinetune): string {
    if (!opts.fromHf) return '';
    return `echo '[hf] resume from ${opts.fromHf}...' && ` +
      `hf download ${opts.fromHf}-dataset --repo-type dataset --local-dir /root --token "$HF_TOKEN" 2>&1 | tail -3 && ` +
      `(hf download ${opts.fromHf}-code --local-dir /workspace --token "$HF_TOKEN" 2>&1 | tail -3 || echo '[hf] no -code repo') && ` +
      `hf download ${opts.fromHf} --local-dir /workspace/checkpoints --token "$HF_TOKEN" 2>&1 | tail -3 && `;
  }

  // ─── R2 / S3 durable storage ───────────────────────────────────────────
  // Independente do HF. Liga quando opts.r2Bucket é setado. Creds vêm do env
  // do gateway (B2_*/STORAGE_*) — mesmo esquema do pod-agent. Sem creds, os
  // estágios viram echo no-op (não quebram dryRun/testes).

  private buildR2Config(opts: ResolvedFinetune): {
    remote: string; bucket: string; prefix: string; exports: string[]; hasCreds: boolean;
  } | null {
    if (!opts.r2Bucket) return null;
    const { accessKey: ak, secretKey: sk, endpoint, region, hasCreds, rcloneProvider, providerKind } = resolveR2Creds(process.env);
    const remote = process.env.AIGW_STORAGE_REMOTE || (providerKind === 'backblaze-b2' ? 'b2aigw' : 'r2aigw');
    const R = remote.toUpperCase();
    const projName = opts.project || opts.preset?.manifest?.name || opts.type;
    const prefix = (opts.r2Prefix || `jobs/${projName}`).replace(/\/+$/, '');
    const exports = hasCreds ? [
      `export RCLONE_CONFIG_${R}_TYPE=s3`,
      `export RCLONE_CONFIG_${R}_PROVIDER=${rcloneProvider}`,
      `export RCLONE_CONFIG_${R}_ENDPOINT=${shellQuote(endpoint)}`,
      `export RCLONE_CONFIG_${R}_ACCESS_KEY_ID=${shellQuote(ak)}`,
      `export RCLONE_CONFIG_${R}_SECRET_ACCESS_KEY=${shellQuote(sk)}`,
      `export RCLONE_CONFIG_${R}_REGION=${shellQuote(region)}`,
      `export RCLONE_CONFIG_${R}_NO_CHECK_BUCKET=true`,
      `export B2_KEY_ID=${shellQuote(ak)}`,
      `export B2_APPLICATION_KEY_ID=${shellQuote(ak)}`,
      `export B2_ACCOUNT_ID=${shellQuote(ak)}`,
      `export B2_APPLICATION_KEY=${shellQuote(sk)}`,
      `export B2_ENDPOINT=${shellQuote(endpoint)}`,
      `export B2_REGION=${shellQuote(region)}`,
      `export RCLONE_BIND=0.0.0.0`,
      `export RCLONE_CONNECT_TIMEOUT=10s`,
      `export RCLONE_TIMEOUT=30s`,
      `export RCLONE_RETRIES=5`,
      `export RCLONE_LOW_LEVEL_RETRIES=20`,
      `export RCLONE_STATS=30s`,
    ] : [];
    return { remote, bucket: opts.r2Bucket, prefix, exports, hasCreds };
  }

  private buildRuntimeDiagnosticsStage(
    opts: ResolvedFinetune,
    r2: ReturnType<FinetuneGateway['buildR2Config']>,
  ): string {
    const hosts = [
      opts.dataset?.startsWith('hf://') || opts.model?.startsWith('hf://') || opts.fromHf ? 'huggingface.co' : '',
      r2?.hasCreds ? this.hostFromEndpoint(resolveR2Creds(process.env).endpoint) : '',
    ].filter(Boolean);
    const hostProbe = hosts.length
      ? hosts.map((h) => `echo '[net] ahosts ${h}'; getent ahosts ${shellQuote(h)} 2>/dev/null | head -8 || true`).join('; ')
      : `echo '[net] no external host probes configured'`;

    return `{ ` +
      `echo '[diag] job bootstrap diagnostics'; ` +
      `__AIGW_HF_TOKEN_TMP="\${HF_TOKEN:-}"; ` +
      `echo "[diag] hf_token_present=$([ -n "$__AIGW_HF_TOKEN_TMP" ] && echo yes || echo no) hf_token_len=\${#__AIGW_HF_TOKEN_TMP}"; ` +
      `echo "[diag] rclone_remote=${r2?.remote ?? 'none'} rclone_bind=\${RCLONE_BIND:-unset}"; ` +
      `if [ -w /etc/gai.conf ]; then ` +
      `grep -q '^precedence ::ffff:0:0/96  100' /etc/gai.conf || printf '\\nprecedence ::ffff:0:0/96  100\\n' >> /etc/gai.conf; ` +
      `echo '[net] prefer IPv4 enabled via /etc/gai.conf'; ` +
      `else echo '[net] /etc/gai.conf not writable; relying on RCLONE_BIND when rclone is used'; fi; ` +
      `ip -brief route 2>/dev/null || true; ` +
      `ip -6 route 2>/dev/null || true; ` +
      `${hostProbe}; ` +
      `} `;
  }

  private hostFromEndpoint(endpoint: string): string {
    try {
      return new URL(endpoint).hostname;
    } catch {
      return endpoint.replace(/^https?:\/\//, '').split('/')[0] || endpoint;
    }
  }

  /** Garante rclone instalado no pod (base image pode não ter). */
  private rcloneEnsure(): string {
    return `{ command -v rclone >/dev/null 2>&1 || ` +
      `{ for i in $(seq 1 5); do ` +
      `rm -rf /tmp/rclone.zip /tmp/rclonezip; ` +
      `curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip && ` +
      `python3 -c "import glob,os,shutil,zipfile; zipfile.ZipFile('/tmp/rclone.zip').extractall('/tmp/rclonezip'); p=glob.glob('/tmp/rclonezip/rclone-*/rclone')[0]; shutil.copy2(p,'/usr/local/bin/rclone'); os.chmod('/usr/local/bin/rclone',0o755)" && break; ` +
      `sleep 5; done; command -v rclone >/dev/null 2>&1; }; }`;
  }

  private aptWait(): string {
    return `for i in $(seq 1 60); do ` +
      `fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1 || break; ` +
      `echo '[apt] waiting for lock'; sleep 5; ` +
      `done`;
  }

  private buildR2RestoreStage(opts: ResolvedFinetune, r2: ReturnType<FinetuneGateway['buildR2Config']>): string {
    const shouldRestore = !!r2 && !opts.smokeOnly && (opts.resumeFromR2 || opts.autoResumeR2 !== false);
    if (!r2 || !shouldRestore) return '';
    if (!r2.hasCreds) {
      return `echo '[r2] auto-resume set mas sem creds R2 no env do gateway — restore pulado' && `;
    }
    const dst = `${r2.remote}:${r2.bucket}/${r2.prefix}/checkpoints`;
    return `${this.rcloneEnsure()} && ` +
      `echo '[r2] checando checkpoints para resume em ${dst}' && mkdir -p /workspace/checkpoints && ` +
      `if rclone lsf ${dst} >/tmp/aigw_r2_resume.lst 2>/tmp/aigw_r2_resume.err && [ -s /tmp/aigw_r2_resume.lst ]; then ` +
      `echo '[r2] restaurando checkpoints de ${dst}'; ` +
      `rclone copy ${dst} /workspace/checkpoints --transfers 8 --checksum 2>&1 | tail -3; ` +
      `else echo '[r2] nenhum checkpoint anterior em ${dst}'; fi && `;
  }

  private buildR2ManifestCommand(): string {
    return `mkdir -p /workspace/checkpoints && ` +
      `find /workspace/checkpoints -maxdepth 1 -type f ` +
      `-printf '{"path":"%f","bytes":%s,"mtime":%T@}\\n' ` +
      `> /workspace/checkpoints/aigw_manifest.jsonl 2>/dev/null || true`;
  }

  private buildR2LiveSyncStart(opts: ResolvedFinetune, r2: ReturnType<FinetuneGateway['buildR2Config']>): string {
    if (!r2 || opts.smokeOnly || !r2.hasCreds) return '';
    const interval = opts.r2SyncIntervalSec ?? 180;
    if (interval <= 0) return '';
    const dst = `${r2.remote}:${r2.bucket}/${r2.prefix}/checkpoints`;
    return `${this.rcloneEnsure()} && echo '[r2] live sync a cada ${interval}s → ${dst}' && ` +
      `{ ( while true; do sleep ${Math.max(5, Math.floor(interval))}; ` +
      `${this.buildR2ManifestCommand()} && ` +
      `rclone sync /workspace/checkpoints ${dst} --transfers 4 --checksum 2>&1 | tail -3 || true; ` +
      `done ) & __AIGW_R2_SYNC_PID=$!; ` +
      `trap 'if [ -n "\${__AIGW_R2_SYNC_PID:-}" ]; then kill "$__AIGW_R2_SYNC_PID" 2>/dev/null || true; fi' EXIT; } && `;
  }

  private buildR2LiveSyncStop(opts: ResolvedFinetune, r2: ReturnType<FinetuneGateway['buildR2Config']>): string {
    if (!r2 || opts.smokeOnly || !r2.hasCreds || (opts.r2SyncIntervalSec ?? 180) <= 0) return '';
    return ` && if [ -n "\${__AIGW_R2_SYNC_PID:-}" ]; then ` +
      `kill "$__AIGW_R2_SYNC_PID" 2>/dev/null || true; ` +
      `wait "$__AIGW_R2_SYNC_PID" 2>/dev/null || true; ` +
      `fi`;
  }

  private buildR2BackupStage(opts: ResolvedFinetune, r2: ReturnType<FinetuneGateway['buildR2Config']>): string {
    if (!r2) return '';
    if (!r2.hasCreds) {
      return ` && echo '[r2] r2Bucket set mas sem creds R2 — backup final pulado'`;
    }
    const dst = `${r2.remote}:${r2.bucket}/${r2.prefix}/checkpoints`;
    return ` && ${this.rcloneEnsure()} && echo '[r2] backup final → ${dst}' && ` +
      `${this.buildR2ManifestCommand()} && ` +
      `rclone sync /workspace/checkpoints ${dst} --transfers 8 --checksum 2>&1 | tail -3`;
  }

  private buildPrepStage(opts: ResolvedFinetune): string {
    const prepareDirective = opts.prepare ?? 'auto';
    if (opts.prepCmd) {
      return `if [ ! -f /root/data_paths.jsonl ]; then ${opts.prepCmd}; else echo '[fine] prep cached'; fi && `;
    }
    if (prepareDirective !== 'skip' && opts.preset?.manifest?.prepareScript) {
      const prepScriptName = basename(opts.preset.manifest.prepareScript);
      return `if [ -f /root/data/metadata.jsonl ]; then ` +
        `python ${prepScriptName} --input /root/data/metadata.jsonl ` +
        `--output /root/data_paths.jsonl --wav-root /root/data; ` +
        `elif [ -f /root/data/train.jsonl ]; then ` +
        `python ${prepScriptName} --input /root/data/train.jsonl ` +
        `--output /root/data_paths.jsonl --wav-root /root/data; ` +
        `else echo '[prep] no metadata.jsonl/train.jsonl in /root/data'; fi && `;
    }
    return '';
  }

  private buildEncodeStage(opts: ResolvedFinetune, scriptName: string): string {
    if (opts.type === 'custom') return '';
    const effectiveMaxSamples = opts.smokeOnly ? opts.smokeMaxSamples : opts.maxSamples;
    const encodeMaxSamples = effectiveMaxSamples ? ` --max-samples ${effectiveMaxSamples}` : '';

    let cmd = opts.encodeCmd;
    if (!cmd) {
      if (opts.type === 'audio') {
        cmd = opts.numGpus > 1
          ? `bash ${dirname(scriptName)}/encode_multi_gpu.sh /root/data_paths.jsonl /root/encoded.pt 8`
          : `python ${scriptName} encode --input /root/data_paths.jsonl --output /root/encoded.pt --num-workers 8${encodeMaxSamples}${this.autoEncodeFlags(opts)}`;
      } else {
        cmd = `python ${scriptName} prepare --dataset /root/data --output /root/prepared.pt`;
      }
    }
    return `if [ ! -f /root/encoded.pt ] && [ ! -f /root/prepared.pt ]; then ${cmd}; else echo '[fine] encode cached'; fi && `;
  }

  private buildTrainStage(opts: ResolvedFinetune, scriptName: string): string {
    if (opts.trainCmd) return opts.trainCmd;

    const tokensArg = opts.type === 'audio' ? '/root/encoded.pt' : '/root/prepared.pt';
    const saveSteps = opts.saveEverySteps ?? (opts.smokeOnly ? 5 : 100);
    const pluginData = opts.plugin ? BUNDLED_PLUGINS[opts.plugin] : undefined;
    const autoFlags = this.autoTrainFlags(opts, saveSteps);

    // r2Bucket defaults to auto-resume so interrupted/preempted runs continue
    // from the restored checkpoint directory when the trainer supports it.
    const doResume = opts.autoResume || (!!opts.r2Bucket && (opts.resumeFromR2 || opts.autoResumeR2 !== false));
    return `python ${scriptName} train ` +
      `--tokens ${tokensArg} --output /workspace/checkpoints ` +
      `--epochs ${opts.epochs} --learning-rate ${opts.lr} --save-every-steps ${saveSteps}${autoFlags} ` +
      `${doResume ? '--resume /workspace/checkpoints ' : ''}` +
      `${opts.extraTrainArgs || ''}${pluginData?.extraTrainArgs ? ' ' + pluginData.extraTrainArgs : ''}`;
  }

  private buildPreSmokeStage(opts: ResolvedFinetune, scriptName: string): string {
    if (!opts.runPreSmoke || opts.type !== 'audio') return '';
    const smokeVerify: SmokeVerifySpec | undefined = opts.preset?.manifest?.preSmokeVerify;
    if (!smokeVerify?.pythonInline) return '';
    return `echo '[smoke] starting pre-full validation (30 samples × 3 epochs)' && ` +
      `python ${scriptName} encode --input /root/data_paths.jsonl --output /root/smoke_encoded.pt --num-workers 8 --max-samples 30 && ` +
      `python ${scriptName} train --tokens /root/smoke_encoded.pt --output /workspace/smoke_ckpt --epochs 3 --learning-rate ${opts.lr} --save-every-steps 5 && ` +
      `python -c "${escapeForShellDoubleQuoted(smokeVerify.pythonInline)}" && `;
  }

  private buildSmokeVerifyInline(opts: ResolvedFinetune): string {
    if (!opts.smokeOnly) return '';
    const smokeVerify: SmokeVerifySpec | undefined = opts.preset?.manifest?.smokeVerify;
    if (!smokeVerify?.pythonInline) return '';
    return ` && python -c "${escapeForShellDoubleQuoted(smokeVerify.pythonInline)}"`;
  }

  private buildCkptAverageStage(opts: ResolvedFinetune): string {
    if (!opts.ckptAverage) return '';
    return ` && python -c "${escapeForShellDoubleQuoted(`
import torch, glob
from safetensors.torch import load_file, save_file
ckpts = sorted(glob.glob('/workspace/checkpoints/step-*.safetensors'), key=lambda p: int(p.rsplit('step-',1)[1].rsplit('.',1)[0]))
last_n = ckpts[-${opts.ckptAverage}:]
print(f'[avg] averaging {len(last_n)} ckpts')
sds = [load_file(p) for p in last_n]
avg = {k: sum(sd[k].float() for sd in sds) / len(sds) for k in sds[0]}
save_file(avg, '/workspace/checkpoints/model_avg.safetensors')
`.trim())}"`;
  }

  private buildPushStage(opts: ResolvedFinetune): string {
    return opts.pushToHf
      ? ` && hf upload ${opts.pushToHf} /workspace/checkpoints --repo-type model --token "$HF_TOKEN"`
      : '';
  }

  private buildWebhookStage(opts: ResolvedFinetune): string {
    return opts.notifyOnComplete
      ? ` && curl -X POST -H 'Content-Type: application/json' -d "{\\"status\\":\\"completed\\",\\"runId\\":\\"$(hostname)\\",\\"ckpt\\":\\"/workspace/checkpoints/model.safetensors\\"}" '${opts.notifyOnComplete}' 2>&1 | tail -3`
      : '';
  }

  // ─── Auto-flag composition ─────────────────────────────────────────────

  private autoEncodeFlags(opts: ResolvedFinetune): string {
    const args: string[] = [];
    const quality = opts.quality ?? 'auto';
    if (opts.augmentPitch ?? quality === 'fast') args.push('--augment-pitch');
    if (opts.augmentSpeed ?? quality === 'fast') args.push('--augment-speed');
    return args.length ? ' ' + args.join(' ') : '';
  }

  private autoTrainFlags(opts: ResolvedFinetune, saveSteps: number): string {
    const args: string[] = [];
    const quality = opts.quality ?? 'auto';
    if (quality !== 'safe' && !opts.smokeOnly) {
      if (opts.torchCompile ?? true) args.push('--torch-compile');
      if (opts.epochs >= 2) args.push(`--auto-stop-plateau ${opts.autoStopPlateau ?? saveSteps * 5}`);
    }
    if (opts.batchSize !== undefined) args.push(`--batch-size ${opts.batchSize}`);
    if (opts.gradAccum !== undefined) args.push(`--grad-accum ${opts.gradAccum}`);
    if (opts.weightDecay !== undefined) args.push(`--weight-decay ${opts.weightDecay}`);
    if (opts.warmupSteps !== undefined) args.push(`--warmup-steps ${opts.warmupSteps}`);
    if (opts.freezeBackboneLayers !== undefined) args.push(`--freeze-backbone-layers ${opts.freezeBackboneLayers}`);
    if (opts.onlyFlowNet) args.push('--only-flow-net');
    if (opts.curriculum) args.push(`--curriculum ${opts.curriculum}`);
    if (opts.seed !== undefined) args.push(`--seed ${opts.seed}`);
    if (opts.gradClip !== undefined) args.push(`--grad-clip ${opts.gradClip}`);
    if (opts.logEverySteps !== undefined) args.push(`--log-every-steps ${opts.logEverySteps}`);
    if (opts.autoLrRewind) {
      args.push('--auto-lr-rewind');
      if (opts.rewindThreshold !== undefined) args.push(`--rewind-threshold ${opts.rewindThreshold}`);
    }
    return args.length ? ' ' + args.join(' ') : '';
  }
}

/** Escape Python source for embedding inside a `python -c "<here>"` shell arg. */
function escapeForShellDoubleQuoted(src: string): string {
  return src.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
}

/** Quote a shell value for POSIX sh without allowing command substitution. */
function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ─── ResolvedFinetune (after preset injection + defaults) ─────────────────

export interface ResolvedFinetune extends FinetuneOpts {
  preset?: Preset;
  scriptPath: string;
  localPath: string;
  smokeOnly: boolean;
  runPreSmoke: boolean;
  runSmokeFirst: boolean;
  numGpus: number;
  epochs: number;
  lr: number;
  gpu: string;
  maxCost: number;
  maxSpend: number;
  output: string;
  preferSpot: boolean;
  reuse: boolean;
  gpuFallback: boolean;
  selectMode: 'cheapest' | 'balanced' | 'fast';
  dryRun: boolean;
  image: string;
  smokeMaxSamples?: number;
}

// Re-export PresetManifest for downstream callers.
export type { PresetManifest };
