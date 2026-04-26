/**
 * GPU Compatibility Engine — analyzes Docker images to determine
 * which GPUs they can run on based on:
 *   - CUDA version requirements
 *   - GPU architecture (Blackwell, Ada, Ampere, Hopper, etc.)
 *   - VRAM requirements (estimated from image name/env/model hints)
 *   - Compute capability requirements
 *
 * Fixes: Static GPU_VRAM_GB map → Dynamic Docker image analysis
 *
 * Usage:
 * ```ts
 * import { analyzeDockerImage, getCompatibleGpus } from './gpu-compat';
 *
 * const analysis = await analyzeDockerImage('marcosremar/babelcast-subtitle:blackwell');
 * console.log(analysis.compatibleGpus);
 * // → ['NVIDIA GeForce RTX 5090', 'NVIDIA H100', ...]
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('gpu-compat');

// ── GPU Database ──────────────────────────────────────────────────────────────

export interface GpuSpec {
  name: string;
  vramGb: number;
  architecture: GpuArchitecture;
  computeCapability: string;
  cudaMinVersion: string;
  tier: 'consumer' | 'datacenter' | 'professional';
}

export type GpuArchitecture = 'blackwell' | 'hopper' | 'ada' | 'ampere' | 'turing' | 'volta' | 'pascal';

/** Complete GPU database with architecture, VRAM, and CUDA requirements */
export const GPU_DATABASE: GpuSpec[] = [
  // Blackwell (CUDA 12.8+)
  { name: 'NVIDIA GeForce RTX 5090', vramGb: 32, architecture: 'blackwell', computeCapability: '12.0', cudaMinVersion: '12.8', tier: 'consumer' },
  { name: 'NVIDIA GeForce RTX 5080', vramGb: 16, architecture: 'blackwell', computeCapability: '12.0', cudaMinVersion: '12.8', tier: 'consumer' },
  { name: 'NVIDIA GeForce RTX 5070 Ti', vramGb: 16, architecture: 'blackwell', computeCapability: '12.0', cudaMinVersion: '12.8', tier: 'consumer' },
  { name: 'NVIDIA GeForce RTX 5070', vramGb: 12, architecture: 'blackwell', computeCapability: '12.0', cudaMinVersion: '12.8', tier: 'consumer' },

  // Hopper (CUDA 12.0+)
  { name: 'NVIDIA H100 80GB HBM3', vramGb: 80, architecture: 'hopper', computeCapability: '9.0', cudaMinVersion: '12.0', tier: 'datacenter' },
  { name: 'NVIDIA H200', vramGb: 141, architecture: 'hopper', computeCapability: '9.0', cudaMinVersion: '12.0', tier: 'datacenter' },

  // Ada Lovelace (CUDA 12.0+)
  { name: 'NVIDIA GeForce RTX 4090', vramGb: 24, architecture: 'ada', computeCapability: '8.9', cudaMinVersion: '12.0', tier: 'consumer' },
  { name: 'NVIDIA GeForce RTX 4080', vramGb: 16, architecture: 'ada', computeCapability: '8.9', cudaMinVersion: '12.0', tier: 'consumer' },
  { name: 'NVIDIA GeForce RTX 4080 SUPER', vramGb: 16, architecture: 'ada', computeCapability: '8.9', cudaMinVersion: '12.0', tier: 'consumer' },
  { name: 'NVIDIA GeForce RTX 4070 Ti', vramGb: 12, architecture: 'ada', computeCapability: '8.9', cudaMinVersion: '12.0', tier: 'consumer' },
  { name: 'NVIDIA GeForce RTX 4070 Ti SUPER', vramGb: 16, architecture: 'ada', computeCapability: '8.9', cudaMinVersion: '12.0', tier: 'consumer' },
  { name: 'NVIDIA L40S', vramGb: 48, architecture: 'ada', computeCapability: '8.9', cudaMinVersion: '12.0', tier: 'datacenter' },
  { name: 'NVIDIA L40', vramGb: 48, architecture: 'ada', computeCapability: '8.9', cudaMinVersion: '12.0', tier: 'datacenter' },
  { name: 'NVIDIA L4', vramGb: 24, architecture: 'ada', computeCapability: '8.9', cudaMinVersion: '12.0', tier: 'datacenter' },

  // Ampere (CUDA 11.0+)
  { name: 'NVIDIA GeForce RTX 3090', vramGb: 24, architecture: 'ampere', computeCapability: '8.6', cudaMinVersion: '11.0', tier: 'consumer' },
  { name: 'NVIDIA GeForce RTX 3080', vramGb: 10, architecture: 'ampere', computeCapability: '8.6', cudaMinVersion: '11.0', tier: 'consumer' },
  { name: 'NVIDIA GeForce RTX 3070', vramGb: 8, architecture: 'ampere', computeCapability: '8.6', cudaMinVersion: '11.0', tier: 'consumer' },
  { name: 'NVIDIA A100-SXM4-80GB', vramGb: 80, architecture: 'ampere', computeCapability: '8.0', cudaMinVersion: '11.0', tier: 'datacenter' },
  { name: 'NVIDIA A100 80GB PCIe', vramGb: 80, architecture: 'ampere', computeCapability: '8.0', cudaMinVersion: '11.0', tier: 'datacenter' },
  { name: 'NVIDIA A100-SXM4-40GB', vramGb: 40, architecture: 'ampere', computeCapability: '8.0', cudaMinVersion: '11.0', tier: 'datacenter' },
  { name: 'NVIDIA A100 40GB PCIe', vramGb: 40, architecture: 'ampere', computeCapability: '8.0', cudaMinVersion: '11.0', tier: 'datacenter' },
  { name: 'NVIDIA A40', vramGb: 48, architecture: 'ampere', computeCapability: '8.6', cudaMinVersion: '11.0', tier: 'datacenter' },
  { name: 'NVIDIA A10G', vramGb: 24, architecture: 'ampere', computeCapability: '8.6', cudaMinVersion: '11.0', tier: 'datacenter' },
  { name: 'NVIDIA RTX A6000', vramGb: 48, architecture: 'ampere', computeCapability: '8.6', cudaMinVersion: '11.0', tier: 'professional' },
  { name: 'NVIDIA RTX A5000', vramGb: 24, architecture: 'ampere', computeCapability: '8.6', cudaMinVersion: '11.0', tier: 'professional' },
  { name: 'NVIDIA RTX A4000', vramGb: 16, architecture: 'ampere', computeCapability: '8.6', cudaMinVersion: '11.0', tier: 'professional' },

  // Turing (CUDA 10.0+)
  { name: 'NVIDIA T4', vramGb: 16, architecture: 'turing', computeCapability: '7.5', cudaMinVersion: '10.0', tier: 'datacenter' },
  { name: 'NVIDIA V100', vramGb: 16, architecture: 'volta', computeCapability: '7.0', cudaMinVersion: '9.0', tier: 'datacenter' },
];

// ── CUDA Version Parsing ──────────────────────────────────────────────────────

export interface CudaVersion {
  major: number;
  minor: number;
  toString(): string;
}

/** Parse CUDA version string like "12.4", "12.8.1", "11.8" */
export function parseCudaVersion(version: string): CudaVersion {
  const parts = version.split('.').map(Number);
  return {
    major: parts[0] ?? 12,
    minor: parts[1] ?? 0,
    toString: () => version,
  };
}

/** Check if CUDA version A >= version B */
export function cudaVersionGte(a: string, b: string): boolean {
  const va = parseCudaVersion(a);
  const vb = parseCudaVersion(b);
  return va.major > vb.major || (va.major === vb.major && va.minor >= vb.minor);
}

// ── Docker Image Analysis ─────────────────────────────────────────────────────

export interface ImageAnalysis {
  /** Original image name */
  imageName: string;
  /** Detected CUDA version from image tag/name */
  detectedCudaVersion: string | null;
  /** Detected GPU architecture requirement */
  detectedArchitecture: GpuArchitecture | null;
  /** Estimated model size from image name/env */
  estimatedVramGb: number;
  /** Model size hint description */
  modelHint: string;
  /** Compatible GPUs with confidence scores */
  compatibleGpus: Array<{ gpu: GpuSpec; confidence: number; reason: string }>;
  /** Incompatible GPUs with reasons */
  incompatibleGpus: Array<{ gpu: GpuSpec; reason: string }>;
  /** Warnings about the image */
  warnings: string[];
}

/**
 * Detect CUDA version from Docker image name/tag.
 *
 * Common patterns:
 *   - `image:cuda12.4` → 12.4
 *   - `image:latest-cu128` → 12.8
 *   - `image:cuda-12.8.1` → 12.8.1
 *   - `image:cu118` → 11.8
 */
function detectCudaFromImageName(imageName: string): string | null {
  const lower = imageName.toLowerCase();

  // Pattern: cuda12.4, cuda-12.8, cuda_12.4
  const cudaMatch = lower.match(/cuda[_\-]?(\d+\.\d+(?:\.\d+)?)/);
  if (cudaMatch) return cudaMatch[1];

  // Pattern: cu128, cu118 (PyTorch style: cu128 = CUDA 12.8)
  const cuMatch = lower.match(/cu(\d{3})/);
  if (cuMatch) {
    const raw = cuMatch[1];
    return `${raw[0]}.${raw.slice(1)}`; // "128" → "12.8"
  }

  // Pattern: blackwell image implies CUDA 12.8+
  if (lower.includes('blackwell')) return '12.8';
  // Pattern: ada image implies CUDA 12.0+
  if (lower.includes('ada')) return '12.0';

  return null;
}

/**
 * Detect GPU architecture requirement from image name.
 */
function detectArchitecture(imageName: string): GpuArchitecture | null {
  const lower = imageName.toLowerCase();

  if (lower.includes('blackwell')) return 'blackwell';
  if (lower.includes('hopper') || lower.includes('h100') || lower.includes('h200')) return 'hopper';
  if (lower.includes('ada') || lower.includes('4090') || lower.includes('4080')) return 'ada';
  if (lower.includes('ampere') || lower.includes('3090') || lower.includes('a100')) return 'ampere';
  if (lower.includes('turing') || lower.includes('t4')) return 'turing';
  if (lower.includes('volta') || lower.includes('v100')) return 'volta';

  return null;
}

/**
 * Estimate VRAM requirement from Docker image metadata.
 *
 * Analyzes:
 * - Image name for model size hints (70b, 13b, etc.)
 * - Quantization hints (q4, q8, fp16, gguf)
 * - Long context hints (32k, 128k)
 * - Multi-model pipeline hints
 */
export function estimateVramFromImage(
  imageName: string,
  envVars: Record<string, string> = {},
  startCmd: string = '',
): { vramGb: number; hint: string } {
  // Combine all sources into a single search string
  const haystack = `${imageName} ${JSON.stringify(envVars)} ${startCmd}`.toLowerCase();

  // Quantization detection
  const isQ2 = /\b(q2|2bit)\b/.test(haystack);
  const isQ3 = /\b(q3|3bit)\b/.test(haystack);
  const isQ4 = /\b(q4|4bit|gguf)\b/.test(haystack);
  const isQ5 = /\b(q5|5bit)\b/.test(haystack);
  const isQ8 = /\b(q8|8bit)\b/.test(haystack);
  const isFp16 = /\b(fp16|half)\b/.test(haystack);
  const isGguf = /\b(gguf|llama\.cpp)\b/.test(haystack);
  const isExl2 = /\b(exl2|exl)\b/.test(haystack);

  // KV cache overhead
  const hasLongContext = /\b(32k|64k|128k|long.context)\b/.test(haystack);
  const kvCacheOverhead = hasLongContext ? 15 : 5;

  // CUDA context overhead
  const cudaOverhead = 3;

  // Multi-model pipeline
  const isMultiModel = /\b(multi|pipeline|stt.*llm|llm.*tts)\b/.test(haystack);
  const multiModelMultiplier = isMultiModel ? 1.5 : 1;

  // Model size detection with quantization-aware base values
  if (/\b(200b|175b)\b/.test(haystack)) {
    const base = isQ4 ? 110 : isQ8 ? 180 : isFp16 ? 350 : isExl2 ? 90 : 400;
    return {
      vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier),
      hint: `200B-class model (quant: ${isQ4 ? 'Q4' : isQ8 ? 'Q8' : isFp16 ? 'FP16' : 'FP32'})`,
    };
  }
  if (/\b(70b|65b|72b)\b/.test(haystack)) {
    const base = isQ4 ? 40 : isQ5 ? 50 : isQ8 ? 75 : isFp16 ? 140 : isGguf ? 42 : isExl2 ? 36 : 48;
    return {
      vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier),
      hint: `70B-class model (quant: ${isQ4 ? 'Q4' : isQ5 ? 'Q5' : isQ8 ? 'Q8' : isFp16 ? 'FP16' : 'FP16'})`,
    };
  }
  if (/\b(32b|33b|34b|35b)\b/.test(haystack)) {
    const base = isQ4 ? 20 : isQ8 ? 36 : isFp16 ? 68 : isGguf ? 22 : isExl2 ? 18 : 24;
    return {
      vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier),
      hint: `32B-class model (quant: ${isQ4 ? 'Q4' : isQ8 ? 'Q8' : isFp16 ? 'FP16' : 'FP16'})`,
    };
  }
  if (/\b(13b|14b|15b)\b/.test(haystack)) {
    const base = isQ4 ? 10 : isQ8 ? 16 : isFp16 ? 28 : isGguf ? 11 : isExl2 ? 9 : 16;
    return {
      vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier),
      hint: `13B-class model (quant: ${isQ4 ? 'Q4' : isQ8 ? 'Q8' : isFp16 ? 'FP16' : 'FP16'})`,
    };
  }
  if (/\b(7b|8b)\b/.test(haystack)) {
    const base = isQ4 ? 5 : isQ8 ? 8 : isFp16 ? 16 : isGguf ? 6 : isExl2 ? 5 : 8;
    return {
      vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier),
      hint: `7B-class model (quant: ${isQ4 ? 'Q4' : isQ8 ? 'Q8' : isFp16 ? 'FP16' : 'FP16'})`,
    };
  }
  if (/\b(3b|4b)\b/.test(haystack)) {
    const base = isQ4 ? 3 : isQ8 ? 4 : isFp16 ? 8 : isGguf ? 3 : 4;
    return {
      vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier),
      hint: `3-4B model (quant: ${isQ4 ? 'Q4' : isQ8 ? 'Q8' : isFp16 ? 'FP16' : 'FP16'})`,
    };
  }

  // STT models (Whisper)
  if (/\bwhisper\b/.test(haystack)) {
    if (/\blarge\b/.test(haystack)) return { vramGb: 10, hint: 'Whisper Large (~10GB)' };
    if (/\bmedium\b/.test(haystack)) return { vramGb: 5, hint: 'Whisper Medium (~5GB)' };
    if (/\bsmall\b/.test(haystack)) return { vramGb: 3, hint: 'Whisper Small (~3GB)' };
    return { vramGb: 2, hint: 'Whisper base/tiny (~2GB)' };
  }

  // TTS models
  if (/\bkokoro\b/.test(haystack)) return { vramGb: 2, hint: 'Kokoro TTS (~2GB)' };
  if (/\borpheus\b/.test(haystack)) return { vramGb: 3, hint: 'Orpheus TTS (~3GB)' };
  if (/\bvall-e\b/.test(haystack)) return { vramGb: 8, hint: 'VALL-E TTS (~8GB)' };

  // Image generation
  if (/\bsdxl\b/.test(haystack)) return { vramGb: 12, hint: 'SDXL (~12GB)' };
  if (/\bflux\b/.test(haystack)) return { vramGb: 24, hint: 'FLUX (~24GB)' };
  if (/\bstable.?diffusion\b/.test(haystack)) return { vramGb: 8, hint: 'Stable Diffusion (~8GB)' };

  return { vramGb: 0, hint: 'Unknown — no model size hint detected' };
}

// ── Compatibility Analysis ────────────────────────────────────────────────────

/**
 * Analyze a Docker image and determine GPU compatibility.
 *
 * @param imageName Docker image name (e.g., 'marcosremar/babelcast-subtitle:blackwell')
 * @param envVars Environment variables passed to the container
 * @param startCmd Container start command
 * @returns Full compatibility analysis
 */
export function analyzeDockerImage(
  imageName: string,
  envVars: Record<string, string> = {},
  startCmd: string = '',
): ImageAnalysis {
  const detectedCudaVersion = detectCudaFromImageName(imageName);
  const detectedArchitecture = detectArchitecture(imageName);
  const { vramGb: estimatedVramGb, hint: modelHint } = estimateVramFromImage(imageName, envVars, startCmd);

  const compatibleGpus: ImageAnalysis['compatibleGpus'] = [];
  const incompatibleGpus: ImageAnalysis['incompatibleGpus'] = [];
  const warnings: string[] = [];

  for (const gpu of GPU_DATABASE) {
    const reasons: string[] = [];
    const disqualifiers: string[] = [];

    // Check 1: VRAM requirement
    if (estimatedVramGb > 0 && gpu.vramGb < estimatedVramGb) {
      disqualifiers.push(`Insufficient VRAM: ${gpu.vramGb}GB < ${estimatedVramGb}GB required`);
    }

    // Check 2: CUDA version compatibility.
    // The image carries `detectedCudaVersion` (CUDA toolkit it was built
    // against). The GPU has `cudaMinVersion` (oldest CUDA it supports).
    // For compatibility, the IMAGE's CUDA must be >= the GPU's minimum —
    // not the other way around. The previous check had the arguments
    // swapped, which incorrectly cleared Blackwell GPUs (cudaMin 12.8)
    // for a CUDA 12.4 image and disqualified Ada GPUs (cudaMin 12.0)
    // that would have worked.
    if (detectedCudaVersion) {
      if (!cudaVersionGte(detectedCudaVersion, gpu.cudaMinVersion)) {
        disqualifiers.push(`Image CUDA ${detectedCudaVersion} < GPU minimum ${gpu.cudaMinVersion}`);
      }
    }

    // Check 3: Architecture requirement
    if (detectedArchitecture) {
      const archOrder: GpuArchitecture[] = ['pascal', 'volta', 'turing', 'ampere', 'ada', 'hopper', 'blackwell'];
      const requiredIdx = archOrder.indexOf(detectedArchitecture);
      const gpuIdx = archOrder.indexOf(gpu.architecture);
      if (gpuIdx < requiredIdx) {
        disqualifiers.push(`Requires ${detectedArchitecture} architecture (GPU is ${gpu.architecture})`);
      }
    }

    if (disqualifiers.length === 0) {
      // GPU is compatible — calculate confidence
      let confidence = 100;

      // Deduct confidence if VRAM is tight (within 20% of requirement)
      if (estimatedVramGb > 0 && gpu.vramGb < estimatedVramGb * 1.2) {
        confidence -= 20;
        reasons.push(`VRAM tight: ${gpu.vramGb}GB vs ${estimatedVramGb}GB needed`);
      }

      // Deduct if architecture is newer than minimum (may have untested issues)
      if (detectedArchitecture && gpu.architecture !== detectedArchitecture) {
        confidence -= 10;
        reasons.push(`Image targets ${detectedArchitecture}, GPU is ${gpu.architecture}`);
      }

      // Boost confidence for exact match
      if (detectedArchitecture && gpu.architecture === detectedArchitecture) {
        confidence = 100;
        reasons.push(`Exact architecture match: ${gpu.architecture}`);
      }

      compatibleGpus.push({
        gpu,
        confidence,
        reason: reasons.length > 0 ? reasons.join('; ') : 'Fully compatible',
      });
    } else {
      incompatibleGpus.push({
        gpu,
        reason: disqualifiers.join('; '),
      });
    }
  }

  // Sort compatible GPUs by confidence descending, then VRAM ascending (cheapest first)
  compatibleGpus.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.gpu.vramGb - b.gpu.vramGb;
  });

  // Generate warnings
  if (estimatedVramGb === 0) {
    warnings.push('Could not estimate VRAM requirement — all GPUs listed as compatible. Add model size hint to image name (e.g., "70b", "q4").');
  }
  if (!detectedCudaVersion) {
    warnings.push('Could not detect CUDA version from image name. Use tag format: image:cuda12.4 or image:cu128.');
  }
  if (compatibleGpus.length === 0) {
    warnings.push('No compatible GPUs found — check image requirements.');
  }

  return {
    imageName,
    detectedCudaVersion,
    detectedArchitecture,
    estimatedVramGb: estimatedVramGb,
    modelHint,
    compatibleGpus,
    incompatibleGpus,
    warnings,
  };
}

/**
 * Get compatible GPUs for a Docker image (shortcut function).
 *
 * @returns Array of compatible GPU names sorted by confidence then VRAM
 */
export function getCompatibleGpus(
  imageName: string,
  envVars: Record<string, string> = {},
  startCmd: string = '',
): string[] {
  const analysis = analyzeDockerImage(imageName, envVars, startCmd);
  return analysis.compatibleGpus.map(c => c.gpu.name);
}

/**
 * Validate that requested GPU types are compatible with a Docker image.
 *
 * @returns Array of validation errors (empty if all valid)
 */
export function validateGpuCompatibility(
  gpuTypes: string[],
  imageName: string,
  envVars: Record<string, string> = {},
  startCmd: string = '',
): string[] {
  const analysis = analyzeDockerImage(imageName, envVars, startCmd);
  const compatibleNames = new Set(analysis.compatibleGpus.map(c => c.gpu.name));
  const errors: string[] = [];

  for (const gpuType of gpuTypes) {
    if (!compatibleNames.has(gpuType)) {
      const incompat = analysis.incompatibleGpus.find(i => i.gpu.name === gpuType);
      if (incompat) {
        errors.push(`${gpuType}: ${incompat.reason}`);
      } else {
        errors.push(`${gpuType}: Unknown GPU type — add to GPU database`);
      }
    }
  }

  return errors;
}
