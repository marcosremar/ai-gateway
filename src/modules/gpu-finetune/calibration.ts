/**
 * Throughput calibration — close the loop so cost estimates self-improve.
 *
 * The cold-start priors in gpu-specs/workload are approximate. After each run we
 * record the REAL observed throughput (train steps/sec, encode samples/sec) keyed
 * by (gpu, model-size bucket, task, finetune-mode) and blend it (EWMA) into a
 * store. Future estimates look up the matching key and use the measured value as
 * the baseline instead of the prior. Pure + dependency-free → unit-tested; the
 * CLI owns persistence (~/.babelcast/finetune_calib.json).
 */

import { lookupGpuSpec } from './gpu-specs.js';
import type { Task, FinetuneMode } from './workload.js';

export interface ThroughputObs {
  /** Optimizer steps per second (train). */
  stepsPerSec?: number;
  /** Samples per second per GPU (encode). */
  encodeRatePerGpu?: number;
}

export interface CalibRecord extends ThroughputObs {
  key: string;
  /** Number of observations blended in (confidence). */
  n: number;
  updatedAt?: string;
}

export type CalibStore = Record<string, CalibRecord>;

// Model-size buckets (billions). Models in the same bucket share calibration —
// a 7B and a 9B finetune behave similarly enough on the same GPU.
const PARAM_BUCKETS: Array<[number, string]> = [
  [0.5, '≤0.5B'], [2, '≤2B'], [4, '≤4B'], [9, '≤9B'],
  [16, '≤16B'], [40, '≤40B'], [90, '≤90B'], [Infinity, '>90B'],
];

function paramBucket(paramsB: number): string {
  for (const [hi, label] of PARAM_BUCKETS) if (paramsB <= hi) return label;
  return '>90B';
}

/** Canonical GPU name (collapse marketplace name variants) for a stable key. */
function gpuKey(gpu: string): string {
  return lookupGpuSpec(gpu)?.name ?? gpu.trim();
}

/** Stable calibration key for a (gpu, model-size, task, mode) combination. */
export function calibKey(gpu: string, paramsB: number, task: Task, mode: FinetuneMode): string {
  return `${gpuKey(gpu)}|${paramBucket(paramsB)}|${task}|${mode}`;
}

/**
 * Turn raw run measurements into a throughput observation. Only emits fields it
 * can compute from positive inputs — never fabricates. trainSteps/trainSec give
 * stepsPerSec; encodeSamples/encodeSec give encodeRatePerGpu (per GPU).
 */
export function observeThroughput(m: {
  trainSteps?: number; trainSec?: number;
  encodeSamples?: number; encodeSec?: number; numGpus?: number;
}): ThroughputObs {
  const obs: ThroughputObs = {};
  if (m.trainSteps && m.trainSec && m.trainSteps > 0 && m.trainSec > 0) {
    obs.stepsPerSec = m.trainSteps / m.trainSec;
  }
  if (m.encodeSamples && m.encodeSec && m.encodeSamples > 0 && m.encodeSec > 0) {
    obs.encodeRatePerGpu = m.encodeSamples / m.encodeSec / Math.max(1, m.numGpus ?? 1);
  }
  return obs;
}

/** Parse a trainer-emitted `[calib] steps_per_sec=X encode_rate_per_gpu=Y` line. */
export function parseCalibLine(logText: string): ThroughputObs {
  const obs: ThroughputObs = {};
  const sps = logText.match(/steps_per_sec=([0-9.]+)/);
  const enc = logText.match(/encode_rate_per_gpu=([0-9.]+)/);
  // Fallback: a bare `rate=X` during encode = samples/s.
  const rate = logText.match(/(?:^|\s)rate=([0-9.]+)/);
  if (sps) obs.stepsPerSec = parseFloat(sps[1]);
  if (enc) obs.encodeRatePerGpu = parseFloat(enc[1]);
  else if (!enc && rate) obs.encodeRatePerGpu = parseFloat(rate[1]);
  return clean(obs);
}

function clean(o: ThroughputObs): ThroughputObs {
  const r: ThroughputObs = {};
  if (typeof o.stepsPerSec === 'number' && Number.isFinite(o.stepsPerSec) && o.stepsPerSec > 0) r.stepsPerSec = o.stepsPerSec;
  if (typeof o.encodeRatePerGpu === 'number' && Number.isFinite(o.encodeRatePerGpu) && o.encodeRatePerGpu > 0) r.encodeRatePerGpu = o.encodeRatePerGpu;
  return r;
}

/**
 * Blend an observation into the store (EWMA, alpha weights the new sample).
 * Returns a NEW store (does not mutate). Fields absent from obs are preserved.
 */
export function applyObservation(
  store: CalibStore,
  key: string,
  obs: ThroughputObs,
  updatedAt?: string,
  alpha = 0.4,
): CalibStore {
  const o = clean(obs);
  if (o.stepsPerSec === undefined && o.encodeRatePerGpu === undefined) return store; // nothing to record
  const prev = store[key];
  const blend = (p: number | undefined, n: number | undefined) =>
    n === undefined ? p : p === undefined ? n : alpha * n + (1 - alpha) * p;
  const next: CalibRecord = {
    key,
    stepsPerSec: blend(prev?.stepsPerSec, o.stepsPerSec),
    encodeRatePerGpu: blend(prev?.encodeRatePerGpu, o.encodeRatePerGpu),
    n: (prev?.n ?? 0) + 1,
    updatedAt,
  };
  return { ...store, [key]: next };
}

/** Look up calibrated throughput for a key (exact match). */
export function lookupCalib(store: CalibStore, key: string): CalibRecord | undefined {
  return store[key];
}
