/**
 * Fine-tune planning: dataset prep, B2 placement, validation, and cost choice.
 *
 * This module is pure/DI-friendly. It does not provision GPUs; it decides what
 * should happen before a finetune run is allowed to spend money.
 */

import type {
  DatasetPrepOption,
  DatasetStoragePlan,
  FinetuneOpts,
  FinetunePlan,
} from './types.js';
import { estimateCost } from './cost.js';
import { resolveProjectOpts } from './spec.js';
import { resolveR2Creds } from './run.js';

export interface FinetunePlannerDeps {
  headObject?: (bucket: string, key: string) => Promise<{ ok: boolean; bytes?: number; detail: string }>;
  minimax?: { chat(req: { model?: string; messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number; responseFormat?: { type: 'json_object' } }): Promise<{ content: string }> };
}

export interface FinetunePlanOptions {
  env?: Record<string, string | undefined>;
  deps?: FinetunePlannerDeps;
  includeAgent?: boolean;
}

const DEFAULT_SAMPLE_COUNT = 7449;
const DEFAULT_CPU_PRICE_PER_HOUR = 0.03;
const DEFAULT_CPU_RATE = 1.25;
const DEFAULT_GPU_PRICE_PER_HOUR = 0.16;
const DEFAULT_GPU_RATE = 25;
const DEFAULT_SELECTED_GPU_PRICE = 0.30;

export async function buildFinetunePlan(
  raw: Partial<FinetuneOpts>,
  options: FinetunePlanOptions = {},
): Promise<FinetunePlan> {
  const env = options.env ?? process.env;
  const { opts: resolvedPartial } = raw.project ? resolveProjectOpts(raw) : { opts: raw };
  const opts = resolvedPartial as Partial<FinetuneOpts>;
  const sampleCount = opts.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  const effectiveSamples = Math.min(opts.maxSamples ?? sampleCount, sampleCount);
  const needsPreparation = inferNeedsPreparation(opts);
  const storage = await buildDatasetStoragePlan(opts, env, options.deps);
  const prepOptions = buildDatasetPrepOptions(opts, effectiveSamples, env);
  const recommended = prepOptions.slice().sort((a, b) => {
    const byCost = a.totalUsd - b.totalUsd;
    if (Math.abs(byCost) > 0.03) return byCost;
    return a.totalMin - b.totalMin;
  })[0]!;
  const blockers = buildBlockers(opts, storage);
  const warnings = buildWarnings(opts, storage, recommended);
  const training = estimateCost(opts, sampleCount, Number(env.AIGW_FINETUNE_SELECTED_GPU_PRICE || DEFAULT_SELECTED_GPU_PRICE));

  const plan: FinetunePlan = {
    project: opts.project,
    type: (opts.type ?? 'audio') as FinetunePlan['type'],
    agent: 'deterministic',
    dataset: {
      source: opts.dataset || opts.r2ShardedRoot,
      sampleCount,
      maxSamples: opts.maxSamples,
      needsPreparation,
      validation: datasetValidationSteps(opts),
    },
    storage,
    economics: {
      options: prepOptions,
      recommended,
      reason: `${recommended.label} has the lowest projected prep cost within the current assumptions.`,
    },
    training,
    blockers,
    warnings,
    nextSteps: buildNextSteps(blockers, warnings, needsPreparation, storage),
  };

  if (options.includeAgent) {
    const agent = await maybeAskMinimax(plan, options.deps?.minimax);
    if (agent.notes) {
      plan.agent = 'minimax';
      plan.agentNotes = agent.notes;
    } else if (agent.error) {
      plan.warnings.push(`Minimax planning agent unavailable: ${agent.error}`);
    }
  }
  return plan;
}

export function parseRcloneUri(uri: string): { remote: string; bucket: string; key: string } | null {
  const m = uri.match(/^([A-Za-z0-9_-]+):([^/]+)\/?(.*)$/);
  if (!m) return null;
  return { remote: m[1]!, bucket: m[2]!, key: (m[3] || '').replace(/^\/+/, '') };
}

function inferNeedsPreparation(opts: Partial<FinetuneOpts>): boolean {
  if (opts.prepare === 'skip') return false;
  if (opts.r2ShardedRoot && opts.r2ShardedManifest) return false;
  if (opts.encodeCmd === 'true' && opts.trainCmd) return false;
  return Boolean(opts.dataset || opts.prepCmd);
}

function datasetValidationSteps(opts: Partial<FinetuneOpts>): string[] {
  const steps = [
    'verify dataset source is reachable',
    'count samples and reject empty shards',
    'validate metadata/audio path pairs',
    'validate language/voice labels and sample rate',
    'write manifest JSONL with byte sizes and checksums',
  ];
  if (opts.r2ShardedManifest) steps.push('head sharded manifest in B2 before GPU reservation');
  if (opts.r2BaseCkpt) steps.push('head base checkpoint in B2 before GPU reservation');
  return steps;
}

async function buildDatasetStoragePlan(
  opts: Partial<FinetuneOpts>,
  env: Record<string, string | undefined>,
  deps: FinetunePlannerDeps = {},
): Promise<DatasetStoragePlan | null> {
  const r2Bucket = opts.r2Bucket || env.B2_BUCKET || env.R2_BUCKET;
  if (!r2Bucket && !opts.r2ShardedRoot) return null;

  const creds = resolveR2Creds(env);
  const bucket = r2Bucket || parseRcloneUri(opts.r2ShardedRoot || '')?.bucket || '';
  const prefix = (opts.r2Prefix || `datasets/${opts.project || opts.type || 'finetune'}`).replace(/^\/+|\/+$/g, '');
  const datasetUri = `${creds.providerKind === 'backblaze-b2' ? 'b2' : 'r2'}://${bucket}/${prefix}`;
  const manifestKey = `${prefix}/manifest.jsonl`;
  const checks: DatasetStoragePlan['checks'] = [];

  const required = [
    opts.r2ShardedManifest,
    opts.r2BaseCkpt,
    opts.r2BaseVocab,
  ].filter(Boolean) as string[];

  for (const target of required) {
    const parsed = parseRcloneUri(target);
    if (!parsed) {
      checks.push({ target, ok: false, detail: 'not an rclone remote path' });
      continue;
    }
    const head = deps.headObject
      ? await deps.headObject(parsed.bucket, parsed.key)
      : { ok: false, detail: 'not checked (no object-store probe injected)' };
    checks.push({ target, ok: head.ok, detail: head.detail, bytes: head.bytes });
  }

  return {
    provider: creds.providerKind,
    bucket,
    prefix,
    datasetUri,
    manifestUri: `${datasetUri.replace(/\/+$/, '')}/manifest.jsonl`,
    exists: checks.length > 0 && checks.every(c => c.ok),
    checked: checks.length > 0,
    checks,
  };
}

function buildDatasetPrepOptions(
  opts: Partial<FinetuneOpts>,
  samples: number,
  env: Record<string, string | undefined>,
): DatasetPrepOption[] {
  const cpuWorkers = Math.max(1, Number(env.AIGW_DATASET_CPU_WORKERS || opts.workers || 20));
  const cpuRate = Number(env.AIGW_DATASET_CPU_SAMPLES_PER_SEC || DEFAULT_CPU_RATE) * cpuWorkers;
  const cpuPrice = Number(env.AIGW_DATASET_CPU_PRICE_PER_HOUR || DEFAULT_CPU_PRICE_PER_HOUR) * cpuWorkers;
  const cheapGpuRate = Number(env.AIGW_DATASET_CHEAP_GPU_SAMPLES_PER_SEC || DEFAULT_GPU_RATE);
  const cheapGpuPrice = Number(env.AIGW_DATASET_CHEAP_GPU_PRICE_PER_HOUR || DEFAULT_GPU_PRICE_PER_HOUR);
  const selectedGpuRate = Number(env.AIGW_DATASET_SELECTED_GPU_SAMPLES_PER_SEC || opts.encodeRatePerGpu || DEFAULT_GPU_RATE);
  const selectedGpuPrice = Number(env.AIGW_FINETUNE_SELECTED_GPU_PRICE || DEFAULT_SELECTED_GPU_PRICE);

  return [
    prepOption('cpu-fanout', `CPU fanout x${cpuWorkers}`, samples, cpuRate, cpuPrice, 4, [
      'best for Kokoro/TTS synthesis and metadata transforms',
      'does not reserve a GPU tier',
    ]),
    prepOption('cheap-gpu', 'cheap GPU dataset worker', samples, cheapGpuRate, cheapGpuPrice, 6, [
      'use when audio encoding needs CUDA but training GPU would be overkill',
    ]),
    prepOption('selected-gpu', `selected training GPU (${opts.gpu || '4090'})`, samples, selectedGpuRate, selectedGpuPrice, 8, [
      'simple path, but may waste high-end GPU time on dataset prep',
    ]),
  ];
}

function prepOption(
  kind: DatasetPrepOption['kind'],
  label: string,
  samples: number,
  samplesPerSec: number,
  pricePerHour: number,
  setupMin: number,
  notes: string[],
): DatasetPrepOption {
  const workMin = samples / Math.max(0.001, samplesPerSec) / 60;
  const totalMin = setupMin + workMin;
  return {
    kind,
    label,
    workers: kind === 'cpu-fanout' ? Math.max(1, Math.round(pricePerHour / DEFAULT_CPU_PRICE_PER_HOUR)) : 1,
    samplesPerSec,
    pricePerHour,
    setupMin,
    totalMin,
    totalUsd: (totalMin / 60) * pricePerHour,
    notes,
  };
}

function buildBlockers(opts: Partial<FinetuneOpts>, storage: DatasetStoragePlan | null): string[] {
  const blockers: string[] = [];
  if (storage?.checks.some(c => !c.ok)) {
    blockers.push('required B2/R2 dataset or checkpoint objects are missing');
  }
  if (opts.r2Bucket && storage && !storage.bucket) {
    blockers.push('r2Bucket is set but no bucket could be resolved');
  }
  if (opts.skipSmoke && !opts.allowSkipSmokeForExpensive && (opts.maxSpend ?? 0) >= 2) {
    blockers.push('full run skips smoke while projected spend is high');
  }
  return blockers;
}

function buildWarnings(
  opts: Partial<FinetuneOpts>,
  storage: DatasetStoragePlan | null,
  recommended: DatasetPrepOption,
): string[] {
  const warnings: string[] = [];
  if (opts.dataset?.startsWith('hf://') && opts.prepare !== 'skip') {
    warnings.push('HF dataset still needs root metadata.jsonl/train.jsonl or an explicit prepCmd');
  }
  if (storage && !storage.checked && (opts.r2Bucket || opts.r2ShardedRoot)) {
    warnings.push('storage credentials are configured, but no concrete object probes were available');
  }
  if (recommended.kind === 'selected-gpu') {
    warnings.push('dataset prep is cheapest on the selected training GPU only under current rate assumptions');
  }
  return warnings;
}

function buildNextSteps(
  blockers: string[],
  warnings: string[],
  needsPreparation: boolean,
  storage: DatasetStoragePlan | null,
): string[] {
  if (blockers.length > 0) {
    return [
      'fix blockers before provisioning a GPU',
      'run finetune plan again and require all B2 object checks to pass',
    ];
  }
  const steps = [];
  if (needsPreparation) steps.push('prepare dataset using the recommended compute option');
  if (storage) steps.push(`upload prepared dataset and manifest to ${storage.datasetUri}`);
  steps.push('run smoke fine-tune before full training');
  if (warnings.length > 0) steps.push('review warnings before allowing skipSmoke');
  return steps;
}

async function maybeAskMinimax(
  plan: FinetunePlan,
  minimax?: FinetunePlannerDeps['minimax'],
): Promise<{ notes?: string; error?: string }> {
  if (!minimax) return { error: 'MINIMAX_API_KEY not configured' };
  try {
    const res = await minimax.chat({
      messages: [
        { role: 'system', content: 'You are a cost-sensitive fine-tuning planner. Return concise operational advice.' },
        { role: 'user', content: JSON.stringify({ plan, ask: 'Check dataset prep, B2 placement, CPU/GPU economics, and blockers.' }) },
      ],
      temperature: 0.2,
      maxTokens: 500,
    });
    return { notes: res.content.trim() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
