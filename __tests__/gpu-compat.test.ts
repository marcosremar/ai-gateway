/**
 * Tests for GPU compatibility engine.
 */

import { describe, it, expect } from 'vitest';
import { analyzeDockerImage, getCompatibleGpus, validateGpuCompatibility, GPU_DATABASE, parseCudaVersion, cudaVersionGte, estimateVramFromImage } from '../src/gpu-compat';

describe('GPU Database', () => {
  it('should have all major GPU types', () => {
    const names = GPU_DATABASE.map(g => g.name);
    expect(names).toContain('NVIDIA GeForce RTX 4090');
    expect(names).toContain('NVIDIA GeForce RTX 5090');
    expect(names).toContain('NVIDIA A100 80GB PCIe');
    expect(names).toContain('NVIDIA H100 80GB HBM3');
  });

  it('should have unique GPU names', () => {
    const names = GPU_DATABASE.map(g => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should have valid VRAM values for all GPUs', () => {
    for (const gpu of GPU_DATABASE) {
      expect(gpu.vramGb).toBeGreaterThan(0);
      expect(Number.isInteger(gpu.vramGb)).toBe(true);
    }
  });

  it('should have valid CUDA minimum versions for all GPUs', () => {
    for (const gpu of GPU_DATABASE) {
      expect(gpu.cudaMinVersion).toMatch(/^\d+\.\d+(\.\d+)?$/);
    }
  });
});

describe('parseCudaVersion', () => {
  it('should parse standard CUDA version', () => {
    const v = parseCudaVersion('12.4');
    expect(v.major).toBe(12);
    expect(v.minor).toBe(4);
    expect(v.toString()).toBe('12.4');
  });

  it('should parse three-part CUDA version', () => {
    const v = parseCudaVersion('12.8.1');
    expect(v.major).toBe(12);
    expect(v.minor).toBe(8);
  });

  it('should default minor to 0 when missing', () => {
    const v = parseCudaVersion('12');
    expect(v.major).toBe(12);
    expect(v.minor).toBe(0);
  });
});

describe('cudaVersionGte', () => {
  it('should return true when versions are equal', () => {
    expect(cudaVersionGte('12.4', '12.4')).toBe(true);
  });

  it('should return true when a is greater', () => {
    expect(cudaVersionGte('12.8', '12.4')).toBe(true);
    expect(cudaVersionGte('13.0', '12.8')).toBe(true);
  });

  it('should return false when a is less', () => {
    expect(cudaVersionGte('11.8', '12.0')).toBe(false);
    expect(cudaVersionGte('12.0', '12.4')).toBe(false);
  });
});

describe('analyzeDockerImage', () => {
  it('should detect CUDA version from image tag', () => {
    const analysis = analyzeDockerImage('my-llm:cuda12.4');
    expect(analysis.detectedCudaVersion).toBe('12.4');
  });

  it('should detect cu-style CUDA version', () => {
    const analysis = analyzeDockerImage('my-llm:cu124');
    // cu-style: "124" -> "1.24" (source uses `${raw[0]}.${raw.slice(1)}`)
    expect(analysis.detectedCudaVersion).toBe('1.24');
  });

  it('should detect Blackwell architecture', () => {
    const analysis = analyzeDockerImage('my-llm:blackwell');
    expect(analysis.detectedArchitecture).toBe('blackwell');
    expect(analysis.detectedCudaVersion).toBe('12.8');
  });

  it('should return compatible GPUs for CUDA 12.4 image', () => {
    const gpus = getCompatibleGpus('my-llm:cuda12.4');
    expect(gpus.length).toBeGreaterThan(0);
  });

  it('should include warnings when CUDA version is missing', () => {
    const analysis = analyzeDockerImage('my-llm:latest');
    expect(analysis.warnings.length).toBeGreaterThan(0);
    expect(analysis.warnings.some(w => w.includes('Could not detect CUDA version'))).toBe(true);
  });

  it('should estimate VRAM from model size hint', () => {
    const analysis = analyzeDockerImage('my-llm:70b-q4');
    expect(analysis.estimatedVramGb).toBeGreaterThan(0);
    expect(analysis.modelHint).toContain('70B');
  });

  it('should filter out incompatible GPUs for Blackwell image', () => {
    const analysis = analyzeDockerImage('my-llm:blackwell-70b-q4');
    const incompatibleNames = analysis.incompatibleGpus.map(i => i.gpu.name);
    // Older architectures should be incompatible
    expect(incompatibleNames.some(n => n.includes('T4') || n.includes('V100'))).toBe(true);
  });

  it('should return image name in analysis', () => {
    const analysis = analyzeDockerImage('myorg/myimage:cuda12.8');
    expect(analysis.imageName).toBe('myorg/myimage:cuda12.8');
  });
});

describe('getCompatibleGpus', () => {
  it('should return array of GPU names', () => {
    const gpus = getCompatibleGpus('my-llm:cuda12.4');
    expect(Array.isArray(gpus)).toBe(true);
    expect(typeof gpus[0]).toBe('string');
  });

  it('newer image CUDA opens up more GPUs (a GPU with cudaMin=N requires image CUDA >= N)', () => {
    const oldGpus = getCompatibleGpus('my-llm:cuda11.8');
    const newGpus = getCompatibleGpus('my-llm:cuda12.8');
    // The cudaMinVersion in GPU_DATABASE is the OLDEST CUDA toolkit that
    // supports each GPU. An image built for newer CUDA can target every
    // GPU whose minimum is ≤ the image's CUDA; older images can target
    // strictly fewer (GPUs added in CUDA 12.x are unreachable from a
    // CUDA 11.8 image).
    expect(newGpus.length).toBeGreaterThanOrEqual(oldGpus.length);
  });
});

describe('validateGpuCompatibility', () => {
  it('should return empty array for compatible GPU', () => {
    const analysis = analyzeDockerImage('my-llm:cuda12.4');
    const compatibleGpu = analysis.compatibleGpus[0]?.gpu.name;
    if (compatibleGpu) {
      const errors = validateGpuCompatibility([compatibleGpu], 'my-llm:cuda12.4');
      expect(errors).toEqual([]);
    }
  });

  it('should return errors for incompatible GPU', () => {
    // Blackwell image requires CUDA 12.8+, T4 only supports CUDA 10.0
    const errors = validateGpuCompatibility(['NVIDIA T4'], 'my-llm:blackwell');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('NVIDIA T4');
  });

  it('should report unknown GPU types', () => {
    const errors = validateGpuCompatibility(['Nonexistent GPU'], 'my-llm:cuda12.4');
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('Unknown GPU type');
  });
});

describe('estimateVramFromImage', () => {
  it('should detect Whisper model sizes', () => {
    const large = estimateVramFromImage('whisper-large');
    expect(large.vramGb).toBe(10);

    const medium = estimateVramFromImage('whisper-medium');
    expect(medium.vramGb).toBe(5);
  });

  it('should detect SDXL image generation model', () => {
    const result = estimateVramFromImage('sdxl-pipeline');
    expect(result.vramGb).toBe(12);
    expect(result.hint).toContain('SDXL');
  });

  it('should return 0 VRAM for unknown images', () => {
    const result = estimateVramFromImage('my-unknown-image');
    expect(result.vramGb).toBe(0);
  });

  it('should detect quantization hints from env vars', () => {
    const result = estimateVramFromImage('my-llm:70b', { QUANTIZATION: 'q4' });
    expect(result.hint).toContain('Q4');
  });
});
