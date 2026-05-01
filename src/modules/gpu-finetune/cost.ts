/**
 * Finetune cost estimation.
 * Predicts encode / train runtime and total cost before submission.
 *
 * Defaults are calibrated for pocket-tts-class workloads (100M flow-matching
 * model on RTX 4090). Override via opts.stepsPerSec / opts.encodeRatePerGpu /
 * opts.sampleCount, or supply explicit args to estimateCost().
 */

import type { FinetuneOpts, FinetuneCostEstimate } from './types.js';

const DEFAULT_SAMPLES = 7449;
const DEFAULT_GPU_PRICE = 0.30; // $/h for RTX 4090 on-demand
const DEFAULT_ENCODE_RATE_PER_GPU = 25; // samples/s (threaded)
const DEFAULT_STEPS_PER_SEC = 3;
const DEFAULT_BATCH_SIZE = 2;
const DEFAULT_GRAD_ACCUM = 16;
const DEFAULT_EPOCHS = 4;
const SETUP_MIN = 8; // apt + pip + HF download

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
): FinetuneCostEstimate {
  const numGpus = opts.numGpus ?? 1;
  const samples = sampleCount ?? opts.sampleCount ?? DEFAULT_SAMPLES;
  const maxSamples = opts.maxSamples;

  const effectiveSamples = maxSamples !== undefined
    ? Math.min(maxSamples, samples)
    : samples;

  const encRate = numGpus * (opts.encodeRatePerGpu ?? DEFAULT_ENCODE_RATE_PER_GPU);
  const encodeMin = effectiveSamples / encRate / 60;

  const effectiveBatch = (opts.batchSize ?? DEFAULT_BATCH_SIZE) * (opts.gradAccum ?? DEFAULT_GRAD_ACCUM);
  const stepsPerEpoch = effectiveSamples / effectiveBatch;
  const totalSteps = (opts.epochs ?? DEFAULT_EPOCHS) * stepsPerEpoch;

  const stepsPerSec = opts.stepsPerSec ?? DEFAULT_STEPS_PER_SEC;
  const trainMin = totalSteps / stepsPerSec / 60;

  const totalMin = encodeMin + trainMin + SETUP_MIN;
  const totalUsd = (totalMin / 60) * gpuPrice;

  return { encodeMin, trainMin, setupMin: SETUP_MIN, totalMin, totalUsd };
}
