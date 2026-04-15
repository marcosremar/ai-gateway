/**
 * GPU VRAM Constants and Validation
 */

import { createLogger } from '../../../src/logger';

const log = createLogger('gpu-vram');

/** Known VRAM (GB) per GPU type name. Used for pre-deploy model-size validation. */
export const GPU_VRAM_GB: Record<string, number> = {
  'NVIDIA GeForce RTX 5090': 32,
  'NVIDIA GeForce RTX 5080': 16,
  'NVIDIA GeForce RTX 5070 Ti': 16,
  'NVIDIA GeForce RTX 5070': 12,
  'NVIDIA GeForce RTX 4090': 24,
  'NVIDIA GeForce RTX 4080': 16,
  'NVIDIA GeForce RTX 4080 SUPER': 16,
  'NVIDIA GeForce RTX 4070 Ti': 12,
  'NVIDIA GeForce RTX 4070 Ti SUPER': 16,
  'NVIDIA GeForce RTX 3090': 24,
  'NVIDIA GeForce RTX 3080': 10,
  'NVIDIA GeForce RTX 3070': 8,
  'NVIDIA RTX A6000': 48,
  'NVIDIA RTX A5000': 24,
  'NVIDIA RTX A4000': 16,
  'NVIDIA L40S': 48,
  'NVIDIA L40': 48,
  'NVIDIA L4': 24,
  'NVIDIA A40': 48,
  'NVIDIA A10G': 24,
  'NVIDIA A100-SXM4-80GB': 80,
  'NVIDIA A100 80GB PCIe': 80,
  'NVIDIA A100-SXM4-40GB': 40,
  'NVIDIA A100 40GB PCIe': 40,
  'NVIDIA H100 80GB HBM3': 80,
  'NVIDIA H200': 141,
  'NVIDIA V100': 16,
  'NVIDIA T4': 16,
};

export interface VramEstimate {
  vramGb: number;
  hint: string;
}

/**
 * Estimate the minimum VRAM (GB) a model needs based on size hints in
 * the Docker image name, onstart command, env vars, or llmModel field.
 * Returns 0 if no model size hint is detected.
 */
export function estimateModelVramGb(
  dockerImage: string,
  dockerStartCmd: string,
  env: Record<string, string>,
  llmModel: string
): VramEstimate {
  const haystack = `${dockerImage} ${dockerStartCmd} ${JSON.stringify(env)} ${llmModel}`.toLowerCase();

  // Check for quantization hints to refine estimation
  const isQ2 = /\b(q2|2bit)\b/.test(haystack);
  const isQ3 = /\b(q3|3bit)\b/.test(haystack);
  const isQ4 = /\b(q4|4bit)\b/.test(haystack);
  const isQ5 = /\b(q5|5bit)\b/.test(haystack);
  const isQ8 = /\b(q8|8bit)\b/.test(haystack);
  const isFp16 = /\b(fp16|half)\b/.test(haystack);
  const isGguf = /\b(gguf|llama\.cpp)\b/.test(haystack);

  // KV cache overhead for long context (adds 5-20GB depending on context length)
  const hasLongContext = /\b(32k|64k|128k|long.context)\b/.test(haystack);
  const kvCacheOverhead = hasLongContext ? 15 : 5;

  // CUDA context overhead (~2-4GB)
  const cudaOverhead = 3;

  // Multi-model setup (STT + LLM + TTS simultaneously)
  const isMultiModel = /\b(multi|pipeline|stt.*llm|llm.*tts)\b/.test(haystack);
  const multiModelMultiplier = isMultiModel ? 1.5 : 1;

  if (/\b(200b|175b)\b/.test(haystack)) {
    let base = isQ4 ? 110 : isQ8 ? 180 : isFp16 ? 350 : 400;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '200B-class model' };
  }
  if (/\b(70b|65b|72b)\b/.test(haystack)) {
    let base = isQ4 ? 40 : isQ5 ? 50 : isQ8 ? 75 : isFp16 ? 140 : isGguf ? 42 : 48;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '70B-class model' };
  }
  if (/\b(32b|33b|34b|35b)\b/.test(haystack)) {
    let base = isQ4 ? 20 : isQ8 ? 36 : isFp16 ? 68 : isGguf ? 22 : 24;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '32B-class model' };
  }
  if (/\b(13b|14b|15b)\b/.test(haystack)) {
    let base = isQ4 ? 10 : isQ8 ? 16 : isFp16 ? 28 : isGguf ? 11 : 16;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '13B-class model' };
  }
  if (/\b(7b|8b)\b/.test(haystack)) {
    let base = isQ4 ? 5 : isQ8 ? 8 : isFp16 ? 16 : isGguf ? 6 : 8;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '7B-class model' };
  }
  if (/\b(3b|4b)\b/.test(haystack)) {
    let base = isQ4 ? 3 : isQ8 ? 4 : isFp16 ? 8 : isGguf ? 3 : 4;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '3-4B model' };
  }

  return { vramGb: 0, hint: '' };
}

/** GPU types with enough VRAM for the given requirement.
 * Unknown GPU types now FAIL validation instead of passing.
 * Unknown GPUs must be explicitly added to GPU_VRAM_GB map first. */
export function gpuTypesWithSufficientVram(gpuTypes: string[], requiredVramGb: number): string[] {
  return gpuTypes.filter(gpu => {
    const vram = GPU_VRAM_GB[gpu];
    // Unknown GPUs fail validation — must be explicitly mapped
    if (vram === undefined) {
      log.warn(`[VRAM] Unknown GPU type "${gpu}" — failing validation. Add to GPU_VRAM_GB map.`);
      return false;
    }
    return vram >= requiredVramGb;
  });
}

/** GPU types that don't have enough VRAM, with their actual VRAM for reporting. */
export function gpuTypesWithInsufficientVram(
  gpuTypes: string[],
  requiredVramGb: number
): Array<{ gpu: string; vram: number }> {
  return gpuTypes
    .filter(gpu => {
      const vram = GPU_VRAM_GB[gpu];
      return vram !== undefined && vram < requiredVramGb;
    })
    .map(gpu => ({ gpu, vram: GPU_VRAM_GB[gpu] }));
}

/**
 * Validate that at least one GPU type has sufficient VRAM.
 * Returns validation result with details.
 */
export function validateVramForModel(
  gpuTypes: string[],
  requiredVramGb: number,
  modelHint: string
): {
  valid: boolean;
  sufficient: string[];
  insufficient: Array<{ gpu: string; vram: number }>;
  message?: string;
} {
  const sufficient = gpuTypesWithSufficientVram(gpuTypes, requiredVramGb);
  const insufficient = gpuTypesWithInsufficientVram(gpuTypes, requiredVramGb);

  if (sufficient.length === 0) {
    const message = `Model requires ${requiredVramGb}GB VRAM (${modelHint}). ` +
      `No GPUs have sufficient VRAM. ` +
      `Available GPUs: ${insufficient.map(g => `${g.gpu}(${g.vram}GB)`).join(', ') || 'none mapped'}`;
    log.error(`[VRAM] ${message}`);
    return { valid: false, sufficient, insufficient, message };
  }

  if (insufficient.length > 0) {
    log.warn(`[VRAM] Model requires ${requiredVramGb}GB VRAM (${modelHint}). ` +
      `Filtered out ${insufficient.length} GPUs with insufficient VRAM: ` +
      insufficient.map(g => `${g.gpu}(${g.vram}GB)`).join(', '));
  }

  return { valid: true, sufficient, insufficient };
}
