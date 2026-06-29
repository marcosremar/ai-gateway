/**
 * GPU VRAM Validation — Unit Tests
 *
 * Covers:
 * 1. GPU_VRAM_GB constant completeness
 * 2. estimateModelVramGb — size-class detection (200B/70B/32B/13B/7B/3B)
 * 3. estimateModelVramGb — quantization modifiers (q4/q8/fp16/gguf)
 * 4. estimateModelVramGb — KV-cache overhead (long context)
 * 5. estimateModelVramGb — multi-model multiplier
 * 6. estimateModelVramGb — haystack sources (image / cmd / env / model)
 * 7. estimateModelVramGb — no-match returns 0
 * 8. gpuTypesWithSufficientVram — filtering
 * 9. gpuTypesWithInsufficientVram — filtering
 * 10. validateVramForModel — valid / invalid / mixed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  GPU_VRAM_GB,
  estimateModelVramGb,
  gpuTypesWithSufficientVram,
  gpuTypesWithInsufficientVram,
  validateVramForModel,
} from '../server/handlers/gpu/vram';

// Silence logger noise in test output
vi.mock('../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// ─── helpers ──────────────────────────────────────────────────────────────────

const noEnv: Record<string, string> = {};

/** Convenience wrapper: only set the dockerImage field. */
function est(dockerImage: string, cmd = '', env: Record<string, string> = {}, llm = '') {
  return estimateModelVramGb(dockerImage, cmd, env, llm);
}

// ─── 1. GPU_VRAM_GB constant ─────────────────────────────────────────────────

describe('GPU_VRAM_GB constant', () => {
  it('maps RTX 5090 to 32 GB', () => {
    expect(GPU_VRAM_GB['NVIDIA GeForce RTX 5090']).toBe(32);
  });

  it('maps RTX 4090 to 24 GB', () => {
    expect(GPU_VRAM_GB['NVIDIA GeForce RTX 4090']).toBe(24);
  });

  it('maps A100-SXM4-80GB to 80 GB', () => {
    expect(GPU_VRAM_GB['NVIDIA A100-SXM4-80GB']).toBe(80);
  });

  it('maps H200 to 141 GB', () => {
    expect(GPU_VRAM_GB['NVIDIA H200']).toBe(141);
  });

  it('maps A6000 to 48 GB', () => {
    expect(GPU_VRAM_GB['NVIDIA RTX A6000']).toBe(48);
  });

  it('maps L40S to 48 GB', () => {
    expect(GPU_VRAM_GB['NVIDIA L40S']).toBe(48);
  });

  it('maps RTX 3080 to 10 GB', () => {
    expect(GPU_VRAM_GB['NVIDIA GeForce RTX 3080']).toBe(10);
  });

  it('returns undefined for unmapped GPU', () => {
    expect(GPU_VRAM_GB['NVIDIA GTX 1080']).toBeUndefined();
  });

  it('has all values as positive integers', () => {
    for (const [gpu, vram] of Object.entries(GPU_VRAM_GB)) {
      expect(vram, `${gpu} should be > 0`).toBeGreaterThan(0);
      expect(Number.isInteger(vram), `${gpu} should be integer`).toBe(true);
    }
  });
});

// ─── 2. estimateModelVramGb — size-class detection ───────────────────────────

describe('estimateModelVramGb — size class detection', () => {
  it('detects 200B class from docker image name', () => {
    const r = est('myorg/llm-200b:latest');
    expect(r.hint).toBe('200B-class model');
    expect(r.vramGb).toBeGreaterThan(0);
  });

  it('detects 175B class (alias for 200B class)', () => {
    const r = est('openai-175b-replica');
    expect(r.hint).toBe('200B-class model');
  });

  it('detects 70B class', () => {
    const r = est('llama3-70b');
    expect(r.hint).toBe('70B-class model');
    expect(r.vramGb).toBeGreaterThan(40);
  });

  it('detects 65B as 70B class', () => {
    const r = est('llama-65b');
    expect(r.hint).toBe('70B-class model');
  });

  it('detects 72B as 70B class', () => {
    const r = est('qwen-72b');
    expect(r.hint).toBe('70B-class model');
  });

  it('detects 32B class', () => {
    const r = est('model-32b');
    expect(r.hint).toBe('32B-class model');
  });

  it('detects 33B as 32B class', () => {
    const r = est('codellama-33b');
    expect(r.hint).toBe('32B-class model');
  });

  it('detects 34B as 32B class', () => {
    const r = est('yi-34b');
    expect(r.hint).toBe('32B-class model');
  });

  it('detects 35B as 32B class', () => {
    const r = est('model-35b');
    expect(r.hint).toBe('32B-class model');
  });

  it('detects 13B class', () => {
    const r = est('llama2-13b');
    expect(r.hint).toBe('13B-class model');
  });

  it('detects 14B as 13B class', () => {
    const r = est('qwen-14b');
    expect(r.hint).toBe('13B-class model');
  });

  it('detects 15B as 13B class', () => {
    const r = est('model-15b');
    expect(r.hint).toBe('13B-class model');
  });

  it('detects 7B class', () => {
    const r = est('llama3-7b');
    expect(r.hint).toBe('7B-class model');
  });

  it('detects 8B as 7B class', () => {
    const r = est('llama3-8b');
    expect(r.hint).toBe('7B-class model');
  });

  it('detects 3B class', () => {
    const r = est('phi3-3b');
    expect(r.hint).toBe('3-4B model');
  });

  it('detects 4B as 3-4B class', () => {
    const r = est('gemma-4b');
    expect(r.hint).toBe('3-4B model');
  });

  it('returns 0 vram and empty hint when no size detected', () => {
    const r = est('my-generic-model:latest', '', {}, '');
    expect(r.vramGb).toBe(0);
    expect(r.hint).toBe('');
  });

  it('matches size in cmd rather than docker image', () => {
    const r = estimateModelVramGb('generic-runner', '--model llama3-70b-instruct', {}, '');
    expect(r.hint).toBe('70B-class model');
  });

  it('matches size in env vars', () => {
    const r = estimateModelVramGb('generic-runner', '', { MODEL: 'llama-13b' }, '');
    expect(r.hint).toBe('13B-class model');
  });

  it('matches size in llmModel field', () => {
    // use a model name where the word boundary around "7b" is clear
    const r = estimateModelVramGb('', '', {}, 'llama3-7b-instruct');
    expect(r.hint).toBe('7B-class model');
  });
});

// ─── 3. estimateModelVramGb — quantization modifiers ─────────────────────────

describe('estimateModelVramGb — quantization modifiers', () => {
  it('q4 reduces 70B estimate vs no-quant', () => {
    const noQuant = est('llama-70b').vramGb;
    const q4 = est('llama-70b-q4').vramGb;
    expect(q4).toBeLessThan(noQuant);
  });

  it('q8 has higher estimate than default for 70B (closer to full precision)', () => {
    // q8 = 8-bit INT quant; the default base already assumes some practical compression.
    // The implementation assigns q8=75 vs default=48 for 70B, so q8 > no-quant.
    const noQuant = est('llama-70b').vramGb;
    const q8 = est('llama-70b-q8').vramGb;
    expect(q8).toBeGreaterThan(noQuant);
  });

  it('fp16 is highest estimate for 70B', () => {
    const fp16 = est('llama-70b-fp16').vramGb;
    const q8 = est('llama-70b-q8').vramGb;
    expect(fp16).toBeGreaterThan(q8);
  });

  it('q4 reduces 7B estimate', () => {
    const noQuant = est('llama-7b').vramGb;
    const q4 = est('llama-7b-q4').vramGb;
    expect(q4).toBeLessThan(noQuant);
  });

  it('gguf reduces estimate for 7B model', () => {
    const noQuant = est('llama-7b').vramGb;
    const gguf = est('llama-7b-gguf').vramGb;
    expect(gguf).toBeLessThan(noQuant);
  });

  it('2bit token in haystack does not crash', () => {
    const r = est('llama-7b-2bit');
    expect(r.hint).toBe('7B-class model');
    expect(r.vramGb).toBeGreaterThan(0);
  });

  it('q5 is between q4 and q8 for 70B', () => {
    // q4=48, q5=58, q8=83 (all + 8 overhead); ordering: q4 < q5 < q8
    const q4 = est('llama-70b-q4').vramGb;
    const q5 = est('llama-70b-q5').vramGb;
    const q8 = est('llama-70b-q8').vramGb;
    expect(q5).toBeGreaterThan(q4);
    expect(q5).toBeLessThan(q8);
  });

  it('half is treated the same as fp16', () => {
    const fp16 = est('llama-70b-fp16').vramGb;
    const half = est('llama-70b-half').vramGb;
    expect(half).toBe(fp16);
  });
});

// ─── 4. estimateModelVramGb — KV-cache overhead ──────────────────────────────

describe('estimateModelVramGb — long-context KV-cache overhead', () => {
  it('32k context adds overhead vs default', () => {
    const normal = est('llama-7b').vramGb;
    const longCtx = est('llama-7b-32k').vramGb;
    expect(longCtx).toBeGreaterThan(normal);
  });

  it('64k context adds same overhead as 32k (both trigger long-context)', () => {
    const ctx32k = est('llama-7b-32k').vramGb;
    const ctx64k = est('llama-7b-64k').vramGb;
    // both add 15 instead of 5 → same net overhead
    expect(ctx64k).toBe(ctx32k);
  });

  it('128k context triggers long-context overhead', () => {
    const normal = est('llama-7b').vramGb;
    const longCtx = est('llama-7b-128k').vramGb;
    expect(longCtx).toBeGreaterThan(normal);
  });

  it('long.context phrase triggers overhead', () => {
    const normal = est('llama-7b').vramGb;
    const longCtx = est('llama-7b-long-context').vramGb;
    expect(longCtx).toBeGreaterThan(normal);
  });
});

// ─── 5. estimateModelVramGb — multi-model multiplier ─────────────────────────

describe('estimateModelVramGb — multi-model multiplier (1.5×)', () => {
  it('pipeline keyword applies 1.5× multiplier', () => {
    const single = est('llama-7b').vramGb;
    const multi = est('llama-7b-pipeline').vramGb;
    // multiplier is applied inside Math.ceil so allow slight rounding
    expect(multi).toBeGreaterThan(single);
  });

  it('multi keyword applies multiplier', () => {
    const single = est('llama-7b').vramGb;
    const multi = est('llama-7b-multi').vramGb;
    expect(multi).toBeGreaterThan(single);
  });

  it('multiplier raises 70B estimate', () => {
    const single = est('llama-70b').vramGb;
    const multi = est('llama-70b-pipeline').vramGb;
    expect(multi).toBeGreaterThan(single);
  });
});

// ─── 6. estimateModelVramGb — haystack sources ───────────────────────────────

describe('estimateModelVramGb — haystack sources', () => {
  it('picks up size from env value', () => {
    const r = estimateModelVramGb('', '', { LLM_MODEL: 'llama-13b-instruct' }, '');
    expect(r.hint).toBe('13B-class model');
  });

  it('picks up size from env value (serialised as JSON)', () => {
    // env is JSON.stringify'd; values like "llama-70b" match the word-boundary regex
    const r = estimateModelVramGb('', '', { MODEL_NAME: 'llama-70b' }, '');
    expect(r.hint).toBe('70B-class model');
  });

  it('picks up size from docker start command', () => {
    const r = estimateModelVramGb('generic', './serve --model llama-32b-instruct', {}, '');
    expect(r.hint).toBe('32B-class model');
  });

  it('picks up size from llmModel param', () => {
    const r = estimateModelVramGb('', '', {}, 'gemma-3b-it');
    expect(r.hint).toBe('3-4B model');
  });

  it('case-insensitive matching', () => {
    const r = estimateModelVramGb('MyOrg/LLAMA-70B:V2', '', {}, '');
    expect(r.hint).toBe('70B-class model');
  });
});

// ─── 7. estimateModelVramGb — no-match fallback ──────────────────────────────

describe('estimateModelVramGb — no-match fallback', () => {
  it('returns 0 vram for empty strings', () => {
    const r = estimateModelVramGb('', '', {}, '');
    expect(r.vramGb).toBe(0);
    expect(r.hint).toBe('');
  });

  it('returns 0 vram for generic image with no size', () => {
    const r = est('babelcast-subtitle:latest');
    expect(r.vramGb).toBe(0);
  });

  it('returns 0 vram when only quantization is present (no size)', () => {
    const r = est('model-q4');
    expect(r.vramGb).toBe(0);
  });

  it('returns whole-number vramGb via Math.ceil', () => {
    const r = est('llama-70b-q4');
    expect(Number.isInteger(r.vramGb)).toBe(true);
  });
});

// ─── 8. gpuTypesWithSufficientVram ───────────────────────────────────────────

describe('gpuTypesWithSufficientVram', () => {
  it('returns all GPUs when requirement is 0', () => {
    const gpus = ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3080'];
    expect(gpuTypesWithSufficientVram(gpus, 0)).toEqual(gpus);
  });

  it('filters out GPUs below threshold', () => {
    const gpus = ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3080']; // 24 GB, 10 GB
    expect(gpuTypesWithSufficientVram(gpus, 16)).toEqual(['NVIDIA GeForce RTX 4090']);
  });

  it('keeps GPUs exactly at threshold', () => {
    const gpus = ['NVIDIA GeForce RTX 4090']; // exactly 24 GB
    expect(gpuTypesWithSufficientVram(gpus, 24)).toEqual(['NVIDIA GeForce RTX 4090']);
  });

  it('returns empty array when none qualify', () => {
    const gpus = ['NVIDIA GeForce RTX 3080']; // 10 GB
    expect(gpuTypesWithSufficientVram(gpus, 48)).toEqual([]);
  });

  it('excludes unknown GPU types', () => {
    const gpus = ['NVIDIA GTX 1080', 'NVIDIA GeForce RTX 4090'];
    // unknown GPU should fail, known should pass
    const result = gpuTypesWithSufficientVram(gpus, 16);
    expect(result).not.toContain('NVIDIA GTX 1080');
    expect(result).toContain('NVIDIA GeForce RTX 4090');
  });

  it('handles empty input', () => {
    expect(gpuTypesWithSufficientVram([], 24)).toEqual([]);
  });

  it('returns large VRAM GPUs for high requirement (80 GB)', () => {
    const gpus = [
      'NVIDIA A100-SXM4-80GB',  // 80 GB — exactly meets
      'NVIDIA H200',             // 141 GB — exceeds
      'NVIDIA GeForce RTX 4090', // 24 GB — fails
    ];
    const result = gpuTypesWithSufficientVram(gpus, 80);
    expect(result).toContain('NVIDIA A100-SXM4-80GB');
    expect(result).toContain('NVIDIA H200');
    expect(result).not.toContain('NVIDIA GeForce RTX 4090');
  });

  it('does not mutate input array', () => {
    const gpus = ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3080'];
    const original = [...gpus];
    gpuTypesWithSufficientVram(gpus, 16);
    expect(gpus).toEqual(original);
  });
});

// ─── 9. gpuTypesWithInsufficientVram ─────────────────────────────────────────

describe('gpuTypesWithInsufficientVram', () => {
  it('returns GPUs below threshold with their VRAM', () => {
    const gpus = ['NVIDIA GeForce RTX 3080', 'NVIDIA GeForce RTX 4090']; // 10, 24
    const result = gpuTypesWithInsufficientVram(gpus, 16);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ gpu: 'NVIDIA GeForce RTX 3080', vram: 10 });
  });

  it('returns empty when all GPUs meet the requirement', () => {
    const gpus = ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000']; // 24, 48
    expect(gpuTypesWithInsufficientVram(gpus, 16)).toEqual([]);
  });

  it('excludes unknown GPU types from insufficient list', () => {
    const gpus = ['NVIDIA GTX 1080'];
    // unknown type is neither sufficient nor insufficient — omitted entirely
    expect(gpuTypesWithInsufficientVram(gpus, 8)).toEqual([]);
  });

  it('handles empty input', () => {
    expect(gpuTypesWithInsufficientVram([], 16)).toEqual([]);
  });

  it('does not include GPUs exactly at threshold', () => {
    const gpus = ['NVIDIA GeForce RTX 4090']; // 24 GB
    expect(gpuTypesWithInsufficientVram(gpus, 24)).toEqual([]);
  });

  it('returns multiple insufficients', () => {
    const gpus = [
      'NVIDIA GeForce RTX 3080',  // 10 GB
      'NVIDIA GeForce RTX 3070',  // 8 GB
      'NVIDIA GeForce RTX 4090',  // 24 GB — sufficient
    ];
    const result = gpuTypesWithInsufficientVram(gpus, 24);
    expect(result).toHaveLength(2);
    const gpuNames = result.map(r => r.gpu);
    expect(gpuNames).toContain('NVIDIA GeForce RTX 3080');
    expect(gpuNames).toContain('NVIDIA GeForce RTX 3070');
  });
});

// ─── 10. validateVramForModel ─────────────────────────────────────────────────

describe('validateVramForModel', () => {
  it('returns valid=true when all GPUs exceed requirement', () => {
    const gpus = ['NVIDIA RTX A6000', 'NVIDIA H200']; // 48, 141 GB
    const result = validateVramForModel(gpus, 24, '7B Q8 model');
    expect(result.valid).toBe(true);
    expect(result.sufficient).toHaveLength(2);
    expect(result.insufficient).toHaveLength(0);
    expect(result.message).toBeUndefined();
  });

  it('returns valid=true when at least one GPU meets requirement', () => {
    const gpus = ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3080']; // 24, 10
    const result = validateVramForModel(gpus, 20, '13B Q4 model');
    expect(result.valid).toBe(true);
    expect(result.sufficient).toContain('NVIDIA GeForce RTX 4090');
    expect(result.insufficient).toHaveLength(1);
  });

  it('returns valid=false when no GPUs have enough VRAM', () => {
    const gpus = ['NVIDIA GeForce RTX 3080']; // 10 GB
    const result = validateVramForModel(gpus, 80, '70B model');
    expect(result.valid).toBe(false);
    expect(result.sufficient).toHaveLength(0);
    expect(result.message).toBeDefined();
    expect(result.message).toContain('80GB');
  });

  it('error message includes model hint', () => {
    const gpus = ['NVIDIA GeForce RTX 3080'];
    const result = validateVramForModel(gpus, 40, '32B Q8');
    expect(result.message).toContain('32B Q8');
  });

  it('error message lists insufficient GPUs', () => {
    const gpus = ['NVIDIA GeForce RTX 3080']; // 10 GB
    const result = validateVramForModel(gpus, 40, 'test');
    expect(result.message).toContain('RTX 3080');
    expect(result.message).toContain('10GB');
  });

  it('error message says "none mapped" when GPU type is unknown', () => {
    const gpus = ['NVIDIA GTX 1080']; // unknown type
    const result = validateVramForModel(gpus, 16, 'test');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('none mapped');
  });

  it('handles empty GPU list', () => {
    const result = validateVramForModel([], 8, 'any model');
    expect(result.valid).toBe(false);
    expect(result.sufficient).toHaveLength(0);
    expect(result.insufficient).toHaveLength(0);
    expect(result.message).toContain('none mapped');
  });

  it('returns valid=true for requirement of 0', () => {
    const gpus = ['NVIDIA GeForce RTX 4090'];
    const result = validateVramForModel(gpus, 0, 'tiny model');
    expect(result.valid).toBe(true);
    expect(result.sufficient).toContain('NVIDIA GeForce RTX 4090');
  });

  it('sufficient and insufficient lists are disjoint', () => {
    const gpus = [
      'NVIDIA GeForce RTX 4090',  // 24 GB — sufficient
      'NVIDIA GeForce RTX 3080',  // 10 GB — insufficient
      'NVIDIA RTX A6000',          // 48 GB — sufficient
    ];
    const result = validateVramForModel(gpus, 16, 'test');
    const suffSet = new Set(result.sufficient);
    const insufSet = new Set(result.insufficient.map(g => g.gpu));
    for (const gpu of suffSet) {
      expect(insufSet.has(gpu)).toBe(false);
    }
  });

  it('returns exact VRAM values in insufficient list', () => {
    const gpus = ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 3070']; // 32, 8
    const result = validateVramForModel(gpus, 24, 'test');
    expect(result.valid).toBe(true);
    const insuf = result.insufficient.find(g => g.gpu === 'NVIDIA GeForce RTX 3070');
    expect(insuf?.vram).toBe(8);
  });
});
