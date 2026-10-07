/**
 * Finetune cost estimation.
 * Predicts encode / train runtime and total cost before submission.
 *
 * Defaults are calibrated for pocket-tts-class workloads (100M flow-matching
 * model on RTX 4090). Override via opts.stepsPerSec / opts.encodeRatePerGpu /
 * opts.sampleCount, or supply explicit args to estimateCost().
 */

import type { FinetuneOpts, FinetuneCostEstimate } from './types.js';
import type { GpuSpec } from './gpu-specs.js';
import { relSpeed } from './gpu-specs.js';
import { scaleStepsPerSec, type WorkloadProfile } from './workload.js';

const DEFAULT_SAMPLES = 7449;
const DEFAULT_GPU_PRICE = 0.30; // $/h for RTX 4090 on-demand
const DEFAULT_ENCODE_RATE_PER_GPU = 25; // samples/s (threaded)
const DEFAULT_STEPS_PER_SEC = 3;
const DEFAULT_BATCH_SIZE = 2;
const DEFAULT_GRAD_ACCUM = 16;
const DEFAULT_EPOCHS = 4;
const SETUP_MIN = 8; // apt + pip + HF download
const BASELINE_CPU_CORES = 8; // cores the DEFAULT_ENCODE_RATE_PER_GPU was measured at

/**
 * Optional context to make the estimate GPU/model/host-aware. When absent,
 * estimateCost behaves exactly as before (pocket-tts-on-4090 defaults).
 */
export interface EstimateCtx {
  /** Target GPU spec — scales train throughput by its speed vs the 4090 baseline. */
  gpuSpec?: GpuSpec;
  /** Model/task profile — scales throughput by model size + finetune mode. */
  workload?: WorkloadProfile;
  /** Baseline steps/sec was measured at this model size (B). Default: workload.paramsB (no param scaling). */
  baselineParamsB?: number;
  /** Baseline tokens-per-step. Default: workload batch×seqLen (no token scaling). */
  baselineTokensPerStep?: number;
  /** Host CPU cores — encode is CPU/IO-bound, NOT GPU-bound; scales encode rate. */
  cpuCores?: number;
  /** Spot/interruptible instance — folds expected eviction overhead into cost. */
  spot?: boolean;
  /** Host reliability 0–1 (spot eviction risk). Higher = less wasted re-work. */
  reliability?: number;
}

/**
 * Estimate finetune cost.
 * @param opts        - FinetuneOpts (subset needed for estimation)
 * @param sampleCount - total samples in dataset (overrides opts.sampleCount; falls back to DEFAULT_SAMPLES)
 * @param gpuPrice    - $/h price for target GPU (default 0.30)
 */
export function estimateCost(
  opts: Partial<FinetuneOpts>,
  sampleCount?: number,
  gpuPrice = DEFAULT_GPU_PRICE,
  ctx: EstimateCtx = {},
): FinetuneCostEstimate {
  const numGpus = opts.numGpus ?? 1;
  const samples = sampleCount ?? opts.sampleCount ?? DEFAULT_SAMPLES;
  const maxSamples = opts.maxSamples;

  const effectiveSamples = maxSamples !== undefined
    ? Math.min(maxSamples, samples)
    : samples;

  // Encode is CPU/IO-bound (Mimi/tokenizer on CPU + disk), NOT GPU-bound — scale
  // by host CPU cores when known, never by GPU TFLOPS.
  const cpuFactor = ctx.cpuCores ? Math.min(Math.max(ctx.cpuCores / BASELINE_CPU_CORES, 0.25), 4) : 1;
  const encRate = numGpus * (opts.encodeRatePerGpu ?? DEFAULT_ENCODE_RATE_PER_GPU) * cpuFactor;
  const encodeMin = effectiveSamples / encRate / 60;

  const effectiveBatch = (opts.batchSize ?? DEFAULT_BATCH_SIZE) * (opts.gradAccum ?? DEFAULT_GRAD_ACCUM);
  const stepsPerEpoch = effectiveSamples / effectiveBatch;
  const totalSteps = (opts.epochs ?? DEFAULT_EPOCHS) * stepsPerEpoch;

  // Train throughput: scale the benchmarked baseline by GPU speed + (when a
  // workload is supplied) model size + finetune mode. Falls back to the flat
  // default, or a pure GPU-speed multiplier when only gpuSpec is known.
  const baseSteps = opts.stepsPerSec ?? DEFAULT_STEPS_PER_SEC;
  let stepsPerSec = baseSteps;
  if (ctx.workload && ctx.gpuSpec) {
    stepsPerSec = scaleStepsPerSec(
      {
        stepsPerSec: baseSteps,
        paramsB: ctx.baselineParamsB ?? ctx.workload.paramsB,
        tokensPerStep: ctx.baselineTokensPerStep ?? ctx.workload.batchSize * ctx.workload.seqLen,
      },
      ctx.workload,
      ctx.gpuSpec,
    );
  } else if (ctx.gpuSpec) {
    stepsPerSec = baseSteps * relSpeed(ctx.gpuSpec);
  }
  const trainMin = totalSteps / stepsPerSec / 60;

  const totalMin = encodeMin + trainMin + SETUP_MIN;
  // Spot: a fraction of runs get evicted and re-do partial work. Coarse: lower
  // reliability → higher expected re-work multiplier on the GPU-time cost.
  const spotMult = ctx.spot ? 1 + (1 - (ctx.reliability ?? 0.9)) * 0.5 : 1;
  const totalUsd = (totalMin / 60) * gpuPrice * spotMult;

  return { encodeMin, trainMin, setupMin: SETUP_MIN, totalMin, totalUsd };
}
