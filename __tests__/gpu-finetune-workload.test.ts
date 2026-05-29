import { describe, it, expect } from 'vitest';
import {
  GPU_SPECS, lookupGpuSpec, gpuVramGb, relSpeed,
} from '../src/modules/gpu-finetune/gpu-specs';
import {
  vramNeedGb, scaleStepsPerSec, detectParamsFromHfConfig, precisionFromHint,
  type WorkloadProfile, type ThroughputBaseline,
} from '../src/modules/gpu-finetune/workload';

const base = (over: Partial<WorkloadProfile> = {}): WorkloadProfile => ({
  paramsB: 7, precision: 'bf16', task: 'finetune', finetuneMode: 'full',
  optimizer: 'adamw', gradCkpt: false, seqLen: 2048, batchSize: 1, ...over,
});

describe('gpu-specs: lookup', () => {
  it('matches exact + fuzzy GPU names', () => {
    expect(lookupGpuSpec('NVIDIA GeForce RTX 4090')?.vramGb).toBe(24);
    expect(lookupGpuSpec('RTX 4090')?.name).toBe('NVIDIA GeForce RTX 4090');
    expect(lookupGpuSpec('4090')?.vramGb).toBe(24);
    expect(lookupGpuSpec('a100 80gb')?.vramGb).toBe(80);
    expect(lookupGpuSpec('5090')?.vramGb).toBe(32);
  });
  it('returns undefined for unknown', () => {
    expect(lookupGpuSpec('GTX 999')).toBeUndefined();
    expect(lookupGpuSpec('')).toBeUndefined();
    expect(gpuVramGb(null)).toBeUndefined();
  });
  it('relSpeed normalizes to 4090 = 1.0 and orders correctly', () => {
    expect(relSpeed(GPU_SPECS['NVIDIA GeForce RTX 4090'])).toBeCloseTo(1, 5);
    expect(relSpeed(GPU_SPECS['NVIDIA H100 80GB HBM3'])).toBeGreaterThan(3);
    expect(relSpeed(GPU_SPECS['NVIDIA GeForce RTX 3090'])).toBeLessThan(1);
  });
});

describe('workload: vramNeedGb', () => {
  it('full finetune needs ~16 B/param of optimizer state (7B does NOT fit 24GB)', () => {
    const need = vramNeedGb(base({ paramsB: 7, finetuneMode: 'full' }));
    expect(need.breakdown.statesGb).toBeCloseTo(7 * 16, 0);
    expect(need.gb).toBeGreaterThan(24); // can't full-finetune 7B on a 4090
  });
  it('QLoRA 7B fits a 24GB card; full 7B does not', () => {
    const qlora = vramNeedGb(base({ paramsB: 7, finetuneMode: 'qlora', precision: 'int4' }));
    const full = vramNeedGb(base({ paramsB: 7, finetuneMode: 'full' }));
    expect(qlora.gb).toBeLessThan(24);
    expect(full.gb).toBeGreaterThan(qlora.gb * 2);
  });
  it('8-bit Adam reduces optimizer state vs vanilla AdamW', () => {
    const a16 = vramNeedGb(base({ optimizer: 'adamw' }));
    const a8 = vramNeedGb(base({ optimizer: 'adamw8bit' }));
    expect(a8.gb).toBeLessThan(a16.gb);
  });
  it('gradient checkpointing cuts activation memory', () => {
    const off = vramNeedGb(base({ gradCkpt: false, batchSize: 8 }));
    const on = vramNeedGb(base({ gradCkpt: true, batchSize: 8 }));
    expect(on.breakdown.activationsGb).toBeLessThan(off.breakdown.activationsGb);
  });
  it('inference needs far less than finetune for the same model', () => {
    const infer = vramNeedGb(base({ task: 'inference' }));
    const ft = vramNeedGb(base({ task: 'finetune', finetuneMode: 'full' }));
    expect(infer.gb).toBeLessThan(ft.gb);
    expect(infer.breakdown.statesGb).toBe(0);
    expect(infer.breakdown.kvGb).toBeGreaterThan(0);
  });
});

describe('workload: scaleStepsPerSec', () => {
  const bl: ThroughputBaseline = { stepsPerSec: 3, paramsB: 0.1, tokensPerStep: 2048 };
  it('a faster GPU yields more steps/sec', () => {
    const p = base({ paramsB: 0.1, batchSize: 1, seqLen: 2048 });
    const on4090 = scaleStepsPerSec(bl, p, GPU_SPECS['NVIDIA GeForce RTX 4090']);
    const onH100 = scaleStepsPerSec(bl, p, GPU_SPECS['NVIDIA H100 80GB HBM3']);
    expect(on4090).toBeCloseTo(3, 1);             // baseline reproduces itself
    expect(onH100).toBeGreaterThan(on4090);
  });
  it('a bigger model is slower', () => {
    const small = scaleStepsPerSec(bl, base({ paramsB: 0.1 }), GPU_SPECS['NVIDIA GeForce RTX 4090']);
    const big = scaleStepsPerSec(bl, base({ paramsB: 7 }), GPU_SPECS['NVIDIA GeForce RTX 4090']);
    expect(big).toBeLessThan(small);
  });
});

describe('workload: detectParamsFromHfConfig', () => {
  it('uses explicit num_parameters when present', () => {
    expect(detectParamsFromHfConfig({ num_parameters: 7_000_000_000 })).toBeCloseTo(7, 1);
  });
  it('derives from hidden_size + layers (≈ Llama-7B class)', () => {
    const p = detectParamsFromHfConfig({ hidden_size: 4096, num_hidden_layers: 32, vocab_size: 32000 });
    expect(p).toBeGreaterThan(5);
    expect(p).toBeLessThan(9);
  });
  it('returns undefined when dims are missing', () => {
    expect(detectParamsFromHfConfig({ model_type: 'whatever' })).toBeUndefined();
  });
});

describe('workload: precisionFromHint', () => {
  it('maps quant hints', () => {
    expect(precisionFromHint('qlora 4bit')).toBe('int4');
    expect(precisionFromHint('load_in_8bit')).toBe('int8');
    expect(precisionFromHint('fp16')).toBe('fp16');
    expect(precisionFromHint(undefined)).toBe('bf16');
  });
});
