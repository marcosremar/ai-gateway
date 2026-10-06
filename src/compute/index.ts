/**
 * Compute helpers — GPU job orchestration, Vast hot pool, workloads, image builder.
 *
 * Tree-shakeable: import only what you need.
 *
 * @example
 * ```ts
 * import { runGpuJob, VastHotPool } from '@parle/ai-gateway/compute';
 *
 * const result = await runGpuJob(deps, {
 *   spec: { gpuTypes: ['NVIDIA GeForce RTX 4090'], dockerImage: 'my/image:latest' },
 *   command: 'python train.py',
 * });
 * ```
 */

export {
  runGpuJob,
  type RunGpuJobDeps,
  type RunGpuJobInput,
  type RunGpuJobResult,
} from './run-gpu-job';

export { VastHotPool } from './vast-hot-pool';
export type { VastHotPoolOpts, VastHotPoolClient } from './vast-hot-pool';
