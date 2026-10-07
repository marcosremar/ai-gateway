/**
 * Workload model — turns "what am I training/running" into VRAM need + a
 * throughput scaling factor, so cost estimation and auto-select can reason
 * about GPU speed, memory, model size, and task (finetune vs inference).
 *
 * All estimates are COARSE planning numbers, documented per-term. The
 * calibration feedback loop (real steps/s per gpu+model) refines them over
 * time; these are the cold-start prior. Pure + dependency-free → unit-tested.
 */

import type { GpuSpec } from './gpu-specs.js';
import { relSpeed } from './gpu-specs.js';

export type Task = 'finetune' | 'inference';
export type Precision = 'bf16' | 'fp16' | 'fp32' | 'int8' | 'int4';
export type FinetuneMode = 'full' | 'lora' | 'qlora';
export type OptimizerKind = 'adamw' | 'adamw8bit' | 'sgd';

export interface WorkloadProfile {
  /** Trainable/base model size in billions of params. */
  paramsB: number;
  /** Base-weight precision on the GPU. */
  precision: Precision;
  task: Task;
  /** Finetune strategy (ignored for inference). */
  finetuneMode: FinetuneMode;
  optimizer: OptimizerKind;
  gradCkpt: boolean;
  /** Sequence length (text tokens, or audio frames) — drives activations + KV. */
  seqLen: number;
  /** Micro-batch (per step, per GPU). */
  batchSize: number;
  /** Optional architecture detail (improves activation estimate when known). */
  hiddenSize?: number;
  numLayers?: number;
}

const CUDA_OVERHEAD_GB = 1.6;     // CUDA context + framework
const HEADROOM = 1.12;            // fragmentation / allocator slack

function precisionBytes(p: Precision): number {
  switch (p) {
    case 'fp32': return 4;
    case 'int8': return 1;
    case 'int4': return 0.5;
    default: return 2; // bf16 / fp16
  }
}

/** Activation memory (GB). Uses arch when known, else a coarse param-scaled term. */
function activationsGb(p: WorkloadProfile): number {
  const tokens = Math.max(1, p.batchSize * p.seqLen);
  let act: number;
  if (p.hiddenSize && p.numLayers) {
    // ~ layers * tokens * hidden * (bytes) * fudge. bf16 activations (2 B).
    act = (p.numLayers * tokens * p.hiddenSize * 2 * 4) / 1e9;
  } else {
    // Coarse fallback: scales with model size and tokens-per-step.
    act = p.paramsB * (tokens / 2048) * 0.8;
  }
  // Gradient checkpointing trades compute for ~5-8x less activation memory.
  return p.gradCkpt ? act / 6 : act;
}

/** KV-cache memory (GB) for inference. Coarse: scales with params, seqLen, batch. */
function kvCacheGb(p: WorkloadProfile): number {
  // ~2 (K+V) * layers * hidden * seqlen * batch * 2B. Approximate layers/hidden
  // from paramsB when arch unknown.
  const layers = p.numLayers ?? Math.max(8, Math.round(12 * Math.cbrt(p.paramsB)));
  const hidden = p.hiddenSize ?? Math.max(512, Math.round(1024 * Math.cbrt(p.paramsB)));
  return (2 * layers * hidden * p.seqLen * p.batchSize * 2) / 1e9;
}

export interface VramNeed {
  gb: number;
  breakdown: { weightsGb: number; statesGb: number; activationsGb: number; kvGb: number; overheadGb: number };
}

/**
 * Estimate minimum VRAM (GB) for a workload. Finetune accounts for optimizer +
 * gradient + activation memory; inference for weights + KV cache.
 */
export function vramNeedGb(p: WorkloadProfile): VramNeed {
  const weightsGb = p.paramsB * precisionBytes(p.precision);
  let statesGb = 0;
  let kvGb = 0;
  let act = 0;

  if (p.task === 'inference') {
    kvGb = kvCacheGb(p);
  } else {
    act = activationsGb(p);
    if (p.finetuneMode === 'full') {
      // mixed-precision AdamW ≈ 16 B/param (w2 + grad2 + master4 + m4 + v4);
      // 8-bit Adam shrinks the two moments → ≈10 B/param.
      const perParam = p.optimizer === 'adamw8bit' ? 10 : p.optimizer === 'sgd' ? 8 : 16;
      statesGb = p.paramsB * perParam;
    } else {
      // LoRA/QLoRA: base weights frozen; only the adapter (~2% of params) carries
      // grad + optimizer state (×16 B). QLoRA's base is already 4-bit (weightsGb).
      statesGb = p.paramsB * 0.02 * 16;
    }
  }

  const overheadGb = CUDA_OVERHEAD_GB;
  const raw = weightsGb + statesGb + act + kvGb;
  const gb = Math.ceil((raw * HEADROOM + overheadGb) * 10) / 10;
  return { gb, breakdown: { weightsGb, statesGb, activationsGb: act, kvGb, overheadGb } };
}

export interface ThroughputBaseline {
  /** Benchmarked optimizer steps/sec for the baseline model on the baseline GPU. */
  stepsPerSec: number;
  /** Baseline model size (B) the stepsPerSec was measured at. */
  paramsB: number;
  /** Baseline tokens-per-step (batch × seqLen) it was measured at. */
  tokensPerStep: number;
}

/**
 * Scale a benchmarked baseline steps/sec to a new model + GPU. Anchored to a
 * real measurement and scaled by RATIOS (safer than absolute FLOPS math):
 *   stepsPerSec ≈ base × relSpeed(gpu) × (baseParams/params) × (baseTokens/tokens) × modeFactor
 */
export function scaleStepsPerSec(
  baseline: ThroughputBaseline,
  p: WorkloadProfile,
  gpu: GpuSpec | undefined,
): number {
  const tokens = Math.max(1, p.batchSize * p.seqLen);
  const paramRatio = baseline.paramsB / Math.max(0.01, p.paramsB);
  const tokenRatio = baseline.tokensPerStep / Math.max(1, tokens);
  // LoRA skips most of the backward weight update; QLoRA pays a dequant tax.
  const modeFactor = p.task === 'inference' ? 1.6
    : p.finetuneMode === 'lora' ? 1.15
    : p.finetuneMode === 'qlora' ? 0.75
    : 1.0;
  const scaled = baseline.stepsPerSec * relSpeed(gpu) * paramRatio * tokenRatio * modeFactor;
  return Math.max(0.01, scaled);
}

/**
 * Estimate model param count (in billions) from a HuggingFace config.json.
 * Prefers an explicit count; else derives from transformer dims. Returns
 * undefined when the config lacks the needed fields.
 */
export function detectParamsFromHfConfig(config: Record<string, unknown>): number | undefined {
  const direct = (config.num_parameters ?? config.n_params ?? config.total_params) as number | undefined;
  if (typeof direct === 'number' && direct > 0) return direct / 1e9;

  const hidden = num(config.hidden_size ?? config.n_embd ?? config.d_model);
  const layers = num(config.num_hidden_layers ?? config.n_layer ?? config.num_layers);
  const vocab = num(config.vocab_size);
  if (hidden && layers) {
    // Decoder transformer: ~12 · L · h²  (attn+MLP) + embeddings (2 · vocab · h).
    const core = 12 * layers * hidden * hidden;
    const emb = vocab ? 2 * vocab * hidden : 0;
    return (core + emb) / 1e9;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Map a precision/quant hint string (from spec or quant flags) to Precision. */
export function precisionFromHint(hint: string | undefined, fallback: Precision = 'bf16'): Precision {
  if (!hint) return fallback;
  const h = hint.toLowerCase();
  if (/int4|nf4|4-?bit|q4|qlora/.test(h)) return 'int4';
  if (/int8|8-?bit|q8/.test(h)) return 'int8';
  if (/fp32|float32/.test(h)) return 'fp32';
  if (/fp16|float16|half/.test(h)) return 'fp16';
  return fallback;
}
