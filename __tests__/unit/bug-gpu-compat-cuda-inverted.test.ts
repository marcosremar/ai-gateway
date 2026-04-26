/**
 * Bug: analyzeDockerImage()'s CUDA compatibility check has its
 * arguments to `cudaVersionGte` swapped, inverting the test:
 *
 *   if (!cudaVersionGte(gpu.cudaMinVersion, detectedCudaVersion))
 *
 * This reads "if the GPU's minimum CUDA is NOT >= the image's CUDA".
 * The correct check is "if the image's CUDA is NOT >= the GPU's
 * minimum CUDA" — `cudaVersionGte(detectedCudaVersion, gpu.cudaMinVersion)`.
 *
 * Net effect: GPUs with NEWER cuda requirements (RTX 5090 / Blackwell,
 * cudaMin 12.8) are reported as compatible with images built for
 * OLDER CUDA (12.4) — which they cannot actually run. And GPUs that
 * SHOULD work with the image (RTX 4090, cudaMin 12.0, image 12.4) get
 * disqualified incorrectly.
 *
 * The user-visible symptom is the deploy preflight green-lighting an
 * RTX 5090 for a CUDA 12.4 image and then crashing inside the
 * container, while skipping the 4090 that would have worked.
 */
import { describe, it, expect } from 'vitest';
import { analyzeDockerImage } from '../../src/gpu-compat';

describe('analyzeDockerImage — CUDA version compatibility', () => {
  it('marks RTX 4090 (cudaMin 12.0) compatible with a CUDA 12.4 image', () => {
    const r = analyzeDockerImage('myorg/myapp:cuda12.4');
    const names = r.compatibleGpus.map((c) => c.gpu.name);
    // The 4090 supports CUDA 12.0+, image built for 12.4 — should be compatible.
    expect(names).toContain('NVIDIA GeForce RTX 4090');
  });

  it('does NOT mark RTX 5090 (cudaMin 12.8) compatible with a CUDA 12.4 image', () => {
    const r = analyzeDockerImage('myorg/myapp:cuda12.4');
    const names = r.compatibleGpus.map((c) => c.gpu.name);
    // 5090 needs CUDA 12.8+; image built for 12.4 cannot run there.
    expect(names).not.toContain('NVIDIA GeForce RTX 5090');
  });
});
