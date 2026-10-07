/**
 * GPU spec table — VRAM, compute throughput, memory bandwidth per GPU type.
 *
 * Used by cost estimation (scale runtime by GPU speed) and auto-select (VRAM
 * feasibility gate + cost-based ranking). This is the canonical finetune-side
 * table; server/handlers/gpu/vram.ts holds a VRAM-only copy for inference
 * deploy validation (the two should eventually converge on this one).
 *
 * THROUGHPUT numbers are approximate dense BF16/FP16 tensor TFLOPS (no
 * sparsity), normalized via relSpeed to RTX 4090 = 1.0. They are for *relative*
 * scaling of a benchmarked baseline — NOT exact perf guarantees. The calibration
 * feedback loop (recording real steps/s per gpu+model) is the source of truth;
 * these are the cold-start prior.
 */

export interface GpuSpec {
  /** Canonical GPU type name (matches PREFERRED_GPU_TYPES / server GPU_VRAM_GB). */
  name: string;
  /** Total VRAM in GB. */
  vramGb: number;
  /** Approximate dense BF16 tensor TFLOPS (no sparsity). For relative scaling. */
  bf16Tflops: number;
  /** Memory bandwidth GB/s — matters for memory-bound (small-model / attention) work. */
  bandwidthGbps: number;
}

/** RTX 4090 is the calibration baseline (relSpeed = 1.0). */
export const BASELINE_GPU = 'NVIDIA GeForce RTX 4090';

// Approximate dense BF16 TFLOPS / bandwidth. Ordered by family.
export const GPU_SPECS: Record<string, GpuSpec> = {
  // Blackwell
  'NVIDIA GeForce RTX 5090': { name: 'NVIDIA GeForce RTX 5090', vramGb: 32, bf16Tflops: 210, bandwidthGbps: 1792 },
  'NVIDIA GeForce RTX 5080': { name: 'NVIDIA GeForce RTX 5080', vramGb: 16, bf16Tflops: 112, bandwidthGbps: 960 },
  // Ada Lovelace
  'NVIDIA GeForce RTX 4090': { name: 'NVIDIA GeForce RTX 4090', vramGb: 24, bf16Tflops: 165, bandwidthGbps: 1008 },
  'NVIDIA GeForce RTX 4080 SUPER': { name: 'NVIDIA GeForce RTX 4080 SUPER', vramGb: 16, bf16Tflops: 104, bandwidthGbps: 736 },
  'NVIDIA GeForce RTX 4080': { name: 'NVIDIA GeForce RTX 4080', vramGb: 16, bf16Tflops: 98, bandwidthGbps: 717 },
  'NVIDIA L40S': { name: 'NVIDIA L40S', vramGb: 48, bf16Tflops: 180, bandwidthGbps: 864 },
  'NVIDIA L40': { name: 'NVIDIA L40', vramGb: 48, bf16Tflops: 90, bandwidthGbps: 864 },
  'NVIDIA L4': { name: 'NVIDIA L4', vramGb: 24, bf16Tflops: 60, bandwidthGbps: 300 },
  // Ampere
  'NVIDIA GeForce RTX 3090': { name: 'NVIDIA GeForce RTX 3090', vramGb: 24, bf16Tflops: 71, bandwidthGbps: 936 },
  'NVIDIA RTX A6000': { name: 'NVIDIA RTX A6000', vramGb: 48, bf16Tflops: 77, bandwidthGbps: 768 },
  'NVIDIA RTX A5000': { name: 'NVIDIA RTX A5000', vramGb: 24, bf16Tflops: 55, bandwidthGbps: 768 },
  'NVIDIA RTX A4000': { name: 'NVIDIA RTX A4000', vramGb: 16, bf16Tflops: 38, bandwidthGbps: 448 },
  'NVIDIA A40': { name: 'NVIDIA A40', vramGb: 48, bf16Tflops: 75, bandwidthGbps: 696 },
  'NVIDIA A10G': { name: 'NVIDIA A10G', vramGb: 24, bf16Tflops: 63, bandwidthGbps: 600 },
  // Datacenter
  'NVIDIA A100-SXM4-80GB': { name: 'NVIDIA A100-SXM4-80GB', vramGb: 80, bf16Tflops: 312, bandwidthGbps: 2039 },
  'NVIDIA A100 80GB PCIe': { name: 'NVIDIA A100 80GB PCIe', vramGb: 80, bf16Tflops: 312, bandwidthGbps: 1935 },
  'NVIDIA A100-SXM4-40GB': { name: 'NVIDIA A100-SXM4-40GB', vramGb: 40, bf16Tflops: 312, bandwidthGbps: 1555 },
  'NVIDIA H100 80GB HBM3': { name: 'NVIDIA H100 80GB HBM3', vramGb: 80, bf16Tflops: 990, bandwidthGbps: 3350 },
  'NVIDIA H200': { name: 'NVIDIA H200', vramGb: 141, bf16Tflops: 990, bandwidthGbps: 4800 },
  'NVIDIA V100': { name: 'NVIDIA V100', vramGb: 16, bf16Tflops: 31, bandwidthGbps: 900 },
  'NVIDIA T4': { name: 'NVIDIA T4', vramGb: 16, bf16Tflops: 65, bandwidthGbps: 320 },
};

const _baselineTflops = GPU_SPECS[BASELINE_GPU].bf16Tflops;

/**
 * Look up a GPU spec by full name or fuzzy substring (e.g. '4090', 'a100').
 * Marketplace offer names vary ("NVIDIA GeForce RTX 4090" vs "RTX 4090" vs
 * "4090"), so match generously: exact → contains canonical → token overlap.
 */
export function lookupGpuSpec(name: string | undefined | null): GpuSpec | undefined {
  if (!name) return undefined;
  if (GPU_SPECS[name]) return GPU_SPECS[name];
  const q = name.toLowerCase().replace(/nvidia|geforce|rtx|\s+/g, ' ').trim();
  let best: GpuSpec | undefined;
  let bestLen = 0;
  for (const spec of Object.values(GPU_SPECS)) {
    const key = spec.name.toLowerCase().replace(/nvidia|geforce|rtx|\s+/g, ' ').trim();
    // Match on the most specific shared token run (e.g. "5090", "a100 80gb").
    if (q.includes(key) || key.includes(q)) {
      if (key.length > bestLen) { best = spec; bestLen = key.length; }
    } else {
      // token overlap fallback (model number like "4090")
      const num = (q.match(/\b(\d{3,4}|a100|h100|h200|a6000|a5000|a4000|a40|a10g|l40s?|l4|t4|v100)\b/) || [])[0];
      if (num && key.includes(num) && num.length > bestLen) { best = spec; bestLen = num.length; }
    }
  }
  return best;
}

/** VRAM (GB) for a GPU name, or undefined if unknown. */
export function gpuVramGb(name: string | undefined | null): number | undefined {
  return lookupGpuSpec(name)?.vramGb;
}

/** Speed of a GPU relative to the RTX 4090 baseline (4090 = 1.0). */
export function relSpeed(spec: GpuSpec | undefined): number {
  if (!spec) return 1;
  return spec.bf16Tflops / _baselineTflops;
}
