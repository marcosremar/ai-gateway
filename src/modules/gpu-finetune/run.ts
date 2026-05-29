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
  maxCost: number;
  maxSpend: number;
  output: string;
  timeoutMin: number;
  bootTimeoutMin?: number;
  image: string;
  provider?: string;        // pin a specific provider (e.g. 'vast') instead of cascade default
  preferSpot: boolean;
  reuseInstance: boolean;
  pullEveryMin: number;
  stallMin: number;
  pullExclude: string[];
  abortOnDivergence: boolean;
  gpuFallback: boolean;
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
      maxCost: resolved.maxCost,
      maxSpend: resolved.maxSpend,
      output: resolved.output,
      timeoutMin: resolved.smokeOnly ? 30 : 360,
      image: resolved.image,
      provider: opts.providers?.[0],   // pin first listed provider (e.g. vast) — server honors body.provider
      preferSpot: resolved.preferSpot,
      reuseInstance: resolved.reuse,
      pullEveryMin: 3,
      stallMin: 30,
      bootTimeoutMin: 10,   // abandon slow/dead instances fast; auto-resubmit picks a new one
      pullExclude: ['data/', 'model/', 'wav/', '*.shard*', '__pycache__/'],
      abortOnDivergence: true,
      gpuFallback: resolved.gpuFallback,
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
      gpuFallback: resolved.gpuFallback ?? false,
      dryRun: resolved.dryRun ?? false,
      image: resolved.image ?? 'aigw-finetune-base',
      scriptPath: resolved.scriptPath!,
      localPath: resolved.localPath!,
    };
    return out;
  }

  // ─── Private: shell script builder ─────────────────────────────────────

  buildShellScript(opts: ResolvedFinetune, scriptName: string): string {
    const token = this.deps.hfToken.resolve();
    const exports = this.buildExports(opts, token);
    const aptStage = this.buildAptStage(opts);
    const pipStage = this.buildPipStage(opts);
    const torchStage = this.buildTorchStage(opts);
    const datasetDl = this.buildDatasetDownload(opts);
    const modelDl = this.buildModelDownload(opts);
    const fromHfStage = this.buildFromHfStage(opts);
    const prepStage = this.buildPrepStage(opts);
    const preSmokeStage = this.buildPreSmokeStage(opts, scriptName);
    const encodeStage = this.buildEncodeStage(opts, scriptName);
    const trainStage = this.buildTrainStage(opts, scriptName);
    const smokeVerifyInline = this.buildSmokeVerifyInline(opts);
    const ckptAvgStage = this.buildCkptAverageStage(opts);
    const pushStage = this.buildPushStage(opts);
    const webhookStage = this.buildWebhookStage(opts);

    const pipeline = opts.smokeOnly
      ? `${prepStage}${encodeStage}${trainStage}${smokeVerifyInline}`
      : `${prepStage}${preSmokeStage}${encodeStage}${trainStage}${ckptAvgStage}${pushStage}${webhookStage}`;

    // Overlap pip install with dataset/model download to save ~2min per run.
    // pip runs in background; dataset + model download in foreground; then we wait for pip.
    // If pip fails, `wait $__PIP` returns non-zero and set -e kills the job.
    const hasDl = datasetDl || modelDl || fromHfStage;
    let installBlock: string;
    if (hasDl && (pipStage || torchStage)) {
      const pipFull = [torchStage, pipStage].filter(Boolean).join(' && ');
      // Launch pip in background before downloads, join after
      installBlock = `{ ${pipFull}; } > /tmp/pip.log 2>&1 & __PIP=$! && ` +
        `${datasetDl}${modelDl}${fromHfStage}true && ` +
        `wait $__PIP || { cat /tmp/pip.log; exit 1; }`;
    } else {
      installBlock = [torchStage, pipStage, `${datasetDl}${modelDl}${fromHfStage}true`].filter(Boolean).join(' && ');
    }

    return [
      'set -euo pipefail',
      `export HF_TOKEN='${token}'`,
      ...exports,
      `export ${opts.noHfTransfer ? '' : 'HF_HUB_ENABLE_HF_TRANSFER=1 '}DEBIAN_FRONTEND=noninteractive`,
      'cd /workspace',
      aptStage,
      installBlock,
      'mkdir -p /workspace/checkpoints',
      pipeline,
    ].filter(Boolean).join(' && ');
  }

  // ─── Stage builders ────────────────────────────────────────────────────

  private buildExports(opts: ResolvedFinetune, _token: string): string[] {
    const { wandb, secrets, hfBase, hfStructure, pushToHf } = opts;
    const hfStructureVal = hfStructure || (hfBase ? 'split' : 'flat');
    const hfWeights = hfBase || pushToHf;
    const hfDataset = hfBase && hfStructureVal !== 'flat' ? `${hfBase}-dataset` : '';
    const hfCode = hfBase && hfStructureVal === 'tri' ? `${hfBase}-code` : '';

    const livePushExports = [
      hfWeights ? `export IARATTS_HF_WEIGHTS_REPO='${hfWeights}'` : '',
      hfDataset ? `export IARATTS_HF_DATASET_REPO='${hfDataset}'` : '',
      hfCode ? `export IARATTS_HF_CODE_REPO='${hfCode}'` : '',
    ].filter(Boolean);

    const wandbExports = wandb
      ? [
          `export WANDB_PROJECT='${wandb.project}'`,
          wandb.entity ? `export WANDB_ENTITY='${wandb.entity}'` : '',
          wandb.runName ? `export WANDB_RUN_NAME='${wandb.runName}'` : '',
          wandb.logModel ? `export WANDB_LOG_MODEL='${wandb.logModel}'` : '',
          process.env.WANDB_API_KEY ? `export WANDB_API_KEY='${process.env.WANDB_API_KEY}'` : '',
        ].filter(Boolean)
      : [];

    const secretExports = secrets
      ? Object.entries(secrets).map(([k, v]) => `export ${k}='${v}'`)
      : [];

    return [...livePushExports, ...wandbExports, ...secretExports];
  }

  private buildAptStage(opts: ResolvedFinetune): string {
    const aptByType: Record<string, string> = {
      text: 'build-essential',
      audio: 'build-essential libsndfile1 ffmpeg',
      custom: 'build-essential',
    };
    const apt = `${aptByType[opts.type] || 'pkg-config build-essential'}${opts.aptPkgs ? ' ' + opts.aptPkgs : ''}`;
    return `apt-get update -q && apt-get install -y -q ${apt}`;
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

    return `python ${scriptName} train ` +
      `--tokens ${tokensArg} --output /workspace/checkpoints ` +
      `--epochs ${opts.epochs} --learning-rate ${opts.lr} --save-every-steps ${saveSteps}${autoFlags} ` +
      `${opts.autoResume ? '--resume /workspace/checkpoints ' : ''}` +
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
  dryRun: boolean;
  image: string;
  smokeMaxSamples?: number;
}

// Re-export PresetManifest for downstream callers.
export type { PresetManifest };
