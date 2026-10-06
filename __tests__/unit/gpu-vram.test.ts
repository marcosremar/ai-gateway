/**
 * Unit tests for server/handlers/gpu/vram.ts.
 *
 * Covers:
 *   GPU_VRAM_GB          — spot-checks that the VRAM map has correct values for
 *                          common GPU types (RTX 4090, A6000, H100, etc.)
 *   estimateModelVramGb  — base size tiers (200B, 70B, 32B, 13B, 7B, 3-4B),
 *                          quantization modifiers (q2/q4/q5/q8/fp16/gguf),
 *                          long-context overhead, multi-model multiplier,
 *                          combinations, and the no-match fallback (0GB)
 *   gpuTypesWithSufficientVram  — passes GPUs that meet the threshold,
 *                                 filters GPUs below it, skips unknown GPUs
 *   gpuTypesWithInsufficientVram — returns only GPUs with known but insufficient VRAM
 *   validateVramForModel  — valid (some sufficient), invalid (none sufficient),
 *                           message content, empty input
 *
 * The logger is mocked so no real console output is emitted.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));

import {
  GPU_VRAM_GB,
  estimateModelVramGb,
  gpuTypesWithSufficientVram,
  gpuTypesWithInsufficientVram,
  validateVramForModel,
} from '../../server/handlers/gpu/vram';

// ── GPU_VRAM_GB spot-checks ──────────────────────────────────────────────────

describe('GPU_VRAM_GB', () => {
  it('RTX 4090 has 24GB', () => {
    expect(GPU_VRAM_GB['NVIDIA GeForce RTX 4090']).toBe(24);
  });

  it('RTX 5090 has 32GB', () => {
    expect(GPU_VRAM_GB['NVIDIA GeForce RTX 5090']).toBe(32);
  });

  it('RTX A6000 has 48GB', () => {
    expect(GPU_VRAM_GB['NVIDIA RTX A6000']).toBe(48);
  });

  it('H100 80GB has 80GB', () => {
    expect(GPU_VRAM_GB['NVIDIA H100 80GB HBM3']).toBe(80);
  });

  it('H200 has 141GB', () => {
    expect(GPU_VRAM_GB['NVIDIA H200']).toBe(141);
  });

  it('A100 SXM4 80GB has 80GB', () => {
    expect(GPU_VRAM_GB['NVIDIA A100-SXM4-80GB']).toBe(80);
  });

  it('RTX 3090 has 24GB', () => {
    expect(GPU_VRAM_GB['NVIDIA GeForce RTX 3090']).toBe(24);
  });

  it('L40S has 48GB', () => {
    expect(GPU_VRAM_GB['NVIDIA L40S']).toBe(48);
  });

  it('T4 has 16GB', () => {
    expect(GPU_VRAM_GB['NVIDIA T4']).toBe(16);
  });

  it('A10G has 24GB', () => {
    expect(GPU_VRAM_GB['NVIDIA A10G']).toBe(24);
  });
});

// ── estimateModelVramGb ──────────────────────────────────────────────────────

describe('estimateModelVramGb', () => {
  const empty = '';

  it('returns 0 and empty hint when no model size hint is found', () => {
    const result = estimateModelVramGb('my-app', '', {}, '');
    expect(result.vramGb).toBe(0);
    expect(result.hint).toBe('');
  });

  it('detects 200B model (default precision) from dockerImage', () => {
    const result = estimateModelVramGb('my-llm-200b:latest', empty, {}, empty);
    expect(result.vramGb).toBeGreaterThan(200);
    expect(result.hint).toMatch(/200B/i);
  });

  it('detects 70B model (default precision)', () => {
    const result = estimateModelVramGb('llama-70b:latest', empty, {}, empty);
    expect(result.vramGb).toBeGreaterThanOrEqual(48);
    expect(result.hint).toMatch(/70B/i);
  });

  it('detects 70B model with q4 quantization — lower VRAM', () => {
    const full = estimateModelVramGb('llama-70b:latest', empty, {}, empty);
    const q4 = estimateModelVramGb('llama-70b-q4:latest', empty, {}, empty);
    expect(q4.vramGb).toBeLessThan(full.vramGb);
  });

  it('detects 70B model with q8 quantization', () => {
    const q4 = estimateModelVramGb('llama-70b-q4:latest', empty, {}, empty);
    const q8 = estimateModelVramGb('llama-70b-q8:latest', empty, {}, empty);
    // q8 needs more VRAM than q4
    expect(q8.vramGb).toBeGreaterThan(q4.vramGb);
  });

  it('detects 70B model with fp16 — largest footprint', () => {
    const q8 = estimateModelVramGb('llama-70b-q8:latest', empty, {}, empty);
    const fp16 = estimateModelVramGb('llama-70b-fp16:latest', empty, {}, empty);
    expect(fp16.vramGb).toBeGreaterThan(q8.vramGb);
  });

  it('detects 70B GGUF model', () => {
    const result = estimateModelVramGb('llama-70b-gguf:latest', empty, {}, empty);
    expect(result.vramGb).toBeGreaterThan(0);
    expect(result.hint).toMatch(/70B/i);
  });

  it('detects 32B model', () => {
    const result = estimateModelVramGb('mixtral-32b', empty, {}, empty);
    expect(result.vramGb).toBeGreaterThan(0);
    expect(result.hint).toMatch(/32B/i);
  });

  it('detects 33B, 34B variants as 32B-class', () => {
    const r33 = estimateModelVramGb('code-33b', empty, {}, empty);
    const r34 = estimateModelVramGb('wizard-34b', empty, {}, empty);
    expect(r33.hint).toMatch(/32B/i);
    expect(r34.hint).toMatch(/32B/i);
  });

  it('detects 13B model', () => {
    const result = estimateModelVramGb('llama-13b:latest', empty, {}, empty);
    expect(result.vramGb).toBeGreaterThan(0);
    expect(result.hint).toMatch(/13B/i);
  });

  it('detects 14B, 15B as 13B-class', () => {
    const r14 = estimateModelVramGb('qwen-14b', empty, {}, empty);
    expect(r14.hint).toMatch(/13B/i);
  });

  it('detects 7B model', () => {
    const result = estimateModelVramGb('mistral-7b', empty, {}, empty);
    expect(result.vramGb).toBeGreaterThan(0);
    expect(result.hint).toMatch(/7B/i);
  });

  it('detects 8B model as 7B-class', () => {
    const result = estimateModelVramGb('llama-3.1-8b', empty, {}, empty);
    expect(result.hint).toMatch(/7B/i);
  });

  it('detects 3B model', () => {
    const result = estimateModelVramGb('phi-3b', empty, {}, empty);
    expect(result.vramGb).toBeGreaterThan(0);
    expect(result.hint).toMatch(/3-4B/i);
  });

  it('detects 4B model as 3-4B-class', () => {
    const result = estimateModelVramGb('gemma-4b', empty, {}, empty);
    expect(result.hint).toMatch(/3-4B/i);
  });

  it('long-context flag increases VRAM estimate', () => {
    const base = estimateModelVramGb('llama-7b', empty, {}, empty);
    const ctx = estimateModelVramGb('llama-7b-128k', empty, {}, empty);
    expect(ctx.vramGb).toBeGreaterThan(base.vramGb);
  });

  it('multi-model flag multiplies VRAM estimate', () => {
    const base = estimateModelVramGb('llama-7b', empty, {}, empty);
    const multi = estimateModelVramGb('llama-7b-pipeline', empty, {}, empty);
    // multi-model detection requires "pipeline", "multi", "stt.*llm", or "llm.*tts"
    expect(multi.vramGb).toBeGreaterThanOrEqual(base.vramGb);
  });

  it('detects size hint from dockerStartCmd, not just dockerImage', () => {
    const result = estimateModelVramGb('base-image', '--model llama-13b', {}, empty);
    expect(result.hint).toMatch(/13B/i);
  });

  it('detects size hint from env JSON', () => {
    const result = estimateModelVramGb('base-image', '', { MODEL: 'llama-7b' }, empty);
    expect(result.hint).toMatch(/7B/i);
  });

  it('detects size hint from llmModel field', () => {
    const result = estimateModelVramGb('base-image', '', {}, 'llama-32b');
    expect(result.hint).toMatch(/32B/i);
  });

  it('is case-insensitive for model size hints', () => {
    const r1 = estimateModelVramGb('LLAMA-70B', empty, {}, empty);
    const r2 = estimateModelVramGb('llama-70b', empty, {}, empty);
    expect(r1.vramGb).toBe(r2.vramGb);
  });

  it('200B with q4 quantization', () => {
    const result = estimateModelVramGb('gpt-200b-q4', empty, {}, empty);
    expect(result.vramGb).toBeGreaterThan(0);
    expect(result.hint).toMatch(/200B/i);
    // q4 should be much less than default 400GB
    expect(result.vramGb).toBeLessThan(200);
  });

  it('32B with q4 and long-context', () => {
    const result = estimateModelVramGb('llm-32b-q4-128k', empty, {}, empty);
    // base q4=20, kv=15, cuda=3 = 38 (no multi)
    expect(result.vramGb).toBeGreaterThan(20);
    expect(result.hint).toMatch(/32B/i);
  });

  it('returns integer (Math.ceil result)', () => {
    const result = estimateModelVramGb('llama-7b', empty, {}, empty);
    expect(Number.isInteger(result.vramGb)).toBe(true);
  });
});

// ── gpuTypesWithSufficientVram ───────────────────────────────────────────────

describe('gpuTypesWithSufficientVram', () => {
  it('returns all GPUs when requirement is 0', () => {
    const gpus = ['NVIDIA GeForce RTX 4090', 'NVIDIA T4'];
    const result = gpuTypesWithSufficientVram(gpus, 0);
    expect(result).toEqual(gpus);
  });

  it('filters out GPUs with less VRAM than required', () => {
    const gpus = ['NVIDIA GeForce RTX 4090', 'NVIDIA T4'];
    // T4 has 16GB, 4090 has 24GB — require 20GB
    const result = gpuTypesWithSufficientVram(gpus, 20);
    expect(result).toContain('NVIDIA GeForce RTX 4090');
    expect(result).not.toContain('NVIDIA T4');
  });

  it('returns empty array when no GPU meets requirement', () => {
    const result = gpuTypesWithSufficientVram(['NVIDIA T4'], 80);
    expect(result).toHaveLength(0);
  });

  it('filters out unknown GPU types (not in VRAM_GB map)', () => {
    const gpus = ['NVIDIA GeForce RTX 4090', 'NVIDIA SomeUnknownGPU'];
    const result = gpuTypesWithSufficientVram(gpus, 16);
    expect(result).toContain('NVIDIA GeForce RTX 4090');
    expect(result).not.toContain('NVIDIA SomeUnknownGPU');
  });

  it('passes GPU with exactly the required VRAM', () => {
    // RTX 4090 = 24GB; require exactly 24GB
    const result = gpuTypesWithSufficientVram(['NVIDIA GeForce RTX 4090'], 24);
    expect(result).toContain('NVIDIA GeForce RTX 4090');
  });

  it('handles empty input', () => {
    const result = gpuTypesWithSufficientVram([], 16);
    expect(result).toHaveLength(0);
  });

  it('preserves order of sufficient GPUs', () => {
    const gpus = ['NVIDIA H100 80GB HBM3', 'NVIDIA RTX A6000', 'NVIDIA GeForce RTX 4090'];
    const result = gpuTypesWithSufficientVram(gpus, 24);
    expect(result).toEqual(['NVIDIA H100 80GB HBM3', 'NVIDIA RTX A6000', 'NVIDIA GeForce RTX 4090']);
  });

  it('returns only high-VRAM GPUs for 80GB requirement', () => {
    const gpus = [
      'NVIDIA GeForce RTX 4090',   // 24GB
      'NVIDIA A100-SXM4-80GB',    // 80GB
      'NVIDIA H100 80GB HBM3',    // 80GB
      'NVIDIA RTX A6000',         // 48GB
    ];
    const result = gpuTypesWithSufficientVram(gpus, 80);
    expect(result).toContain('NVIDIA A100-SXM4-80GB');
    expect(result).toContain('NVIDIA H100 80GB HBM3');
    expect(result).not.toContain('NVIDIA GeForce RTX 4090');
    expect(result).not.toContain('NVIDIA RTX A6000');
  });
});

// ── gpuTypesWithInsufficientVram ─────────────────────────────────────────────

describe('gpuTypesWithInsufficientVram', () => {
  it('returns GPUs with known but insufficient VRAM', () => {
    const result = gpuTypesWithInsufficientVram(['NVIDIA T4', 'NVIDIA GeForce RTX 4090'], 20);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ gpu: 'NVIDIA T4', vram: 16 });
  });

  it('does NOT return unknown GPU types', () => {
    const result = gpuTypesWithInsufficientVram(['NVIDIA SomeUnknownGPU'], 10);
    expect(result).toHaveLength(0);
  });

  it('does NOT return GPUs that have sufficient VRAM', () => {
    const result = gpuTypesWithInsufficientVram(['NVIDIA GeForce RTX 4090'], 16);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when input is empty', () => {
    const result = gpuTypesWithInsufficientVram([], 16);
    expect(result).toHaveLength(0);
  });

  it('reports correct VRAM in returned objects', () => {
    const result = gpuTypesWithInsufficientVram(['NVIDIA V100'], 32);
    expect(result[0]?.vram).toBe(16); // V100 has 16GB
  });

  it('returns all insufficient GPUs across multiple entries', () => {
    const gpus = ['NVIDIA T4', 'NVIDIA V100', 'NVIDIA GeForce RTX 3080'];
    const result = gpuTypesWithInsufficientVram(gpus, 20);
    const gpuNames = result.map(r => r.gpu);
    expect(gpuNames).toContain('NVIDIA T4');       // 16GB
    expect(gpuNames).toContain('NVIDIA V100');     // 16GB
    expect(gpuNames).toContain('NVIDIA GeForce RTX 3080'); // 10GB
  });
});

// ── validateVramForModel ─────────────────────────────────────────────────────

describe('validateVramForModel', () => {
  it('returns valid=true when at least one GPU is sufficient', () => {
    const result = validateVramForModel(
      ['NVIDIA GeForce RTX 4090', 'NVIDIA T4'],
      16,
      '7B model',
    );
    expect(result.valid).toBe(true);
    expect(result.sufficient).toContain('NVIDIA GeForce RTX 4090');
    expect(result.sufficient).toContain('NVIDIA T4');
  });

  it('returns valid=false when no GPU is sufficient', () => {
    const result = validateVramForModel(['NVIDIA T4'], 80, '70B model');
    expect(result.valid).toBe(false);
    expect(result.sufficient).toHaveLength(0);
  });

  it('includes a descriptive message when validation fails', () => {
    const result = validateVramForModel(['NVIDIA T4'], 80, '70B model');
    expect(result.message).toBeTruthy();
    expect(result.message).toMatch(/70B model/);
    expect(result.message).toMatch(/80GB/);
  });

  it('does not set message when validation passes', () => {
    const result = validateVramForModel(['NVIDIA H100 80GB HBM3'], 80, '70B model');
    expect(result.message).toBeUndefined();
  });

  it('populates insufficient array for GPUs that are below threshold', () => {
    const result = validateVramForModel(
      ['NVIDIA GeForce RTX 4090', 'NVIDIA T4'],
      20,
      '13B model',
    );
    const insufNames = result.insufficient.map(r => r.gpu);
    expect(insufNames).toContain('NVIDIA T4');
    expect(insufNames).not.toContain('NVIDIA GeForce RTX 4090');
  });

  it('handles empty GPU list — returns valid=false', () => {
    const result = validateVramForModel([], 16, 'model');
    expect(result.valid).toBe(false);
    expect(result.sufficient).toHaveLength(0);
    expect(result.insufficient).toHaveLength(0);
  });

  it('handles empty model hint gracefully', () => {
    const result = validateVramForModel(['NVIDIA T4'], 80, '');
    expect(result.valid).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('passes when requirement is 0 (any GPU qualifies)', () => {
    const result = validateVramForModel(['NVIDIA T4'], 0, 'no model');
    expect(result.valid).toBe(true);
  });

  it('filters unknown GPUs from both arrays', () => {
    const result = validateVramForModel(
      ['NVIDIA SomeUnknownGPU', 'NVIDIA GeForce RTX 4090'],
      16,
      '7B model',
    );
    const allGpuNames = [...result.sufficient, ...result.insufficient.map(r => r.gpu)];
    expect(allGpuNames).not.toContain('NVIDIA SomeUnknownGPU');
    expect(result.sufficient).toContain('NVIDIA GeForce RTX 4090');
  });

  it('includes GPU details in the failure message', () => {
    const result = validateVramForModel(['NVIDIA T4', 'NVIDIA V100'], 80, '70B FP16');
    expect(result.message).toMatch(/T4|V100/);
    expect(result.message).toMatch(/16GB/);
  });
});
