/**
 * GPU Finetune module.
 *
 * Usage:
 *   import { FinetuneGateway, InMemoryFinetuneState, EnvHfTokenResolver } '../../../../gpu-finetune';
 *
 *   const gateway = new FinetuneGateway({
 *     stateStore: new InMemoryFinetuneState(),
 *     hfToken: new EnvHfTokenResolver(),
 *     jobRunner: myJobRunner,
 *     probe: myProbe,
 *     log: console,
 *   });
 *
 *   const { main } = gateway.compose(opts);
 *   const result = await gateway.run(opts);
 */

// Types
export type {
  FinetuneOpts,
  FinetuneType,
  QualityMode,
  HfStructure,
  FinetuneStage,
  FinetuneStatusResult,
  FinetuneCostEstimate,
  ValidationResult,
  FinetuneRunRecord,
  Preset,
  PresetManifest,
  Project,
  ProjectManifest,
  Plugin,
  TrainerInterface,
  SmokeVerifySpec,
  ProbePathsSpec,
  StageDetectorPatterns,
} from './types.js';
export { BUNDLED_PLUGINS } from './types.js';

// Spec validation + project loading
export {
  validateSpec,
  loadPreset, listPresets, setPresetsRoot, lintPresetManifest,
  loadProject, listProjects, setProjectsRoot, resolveProjectOpts,
  runNumericChecks,
} from './spec.js';
export type { NumericCheckResult } from './spec.js';

// Cost estimation
export { estimateCost } from './cost.js';
export type { EstimateCtx } from './cost.js';

// GPU specs + workload model (VRAM feasibility + throughput scaling)
export { GPU_SPECS, BASELINE_GPU, lookupGpuSpec, gpuVramGb, relSpeed } from './gpu-specs.js';
export type { GpuSpec } from './gpu-specs.js';
export {
  vramNeedGb, scaleStepsPerSec, detectParamsFromHfConfig, precisionFromHint,
} from './workload.js';
export type {
  WorkloadProfile, Task, Precision, FinetuneMode, OptimizerKind, VramNeed, ThroughputBaseline,
} from './workload.js';

// Fail-fast preflight (live HF/R2/script checks before GPU spend)
export { preflightChecks } from './preflight.js';
export type { PreflightCheck, PreflightResult, PreflightStatus, PreflightDeps } from './preflight.js';

// Preset scaffolding (generate a new preset skeleton)
export { scaffoldPreset, STD_PATHS } from './scaffold.js';
export type { ScaffoldFile, ScaffoldOpts, ScaffoldType } from './scaffold.js';

// Status / probe
export { parseProbeOutput, detectStage, buildStatusResult, buildProbeCommand } from './status.js';
export type { ProbeOutput } from './status.js';

// Compare
export { runCompare, parseCompareOutput } from './compare.js';
export type { CompareOpts, CompareResult, CompareRow } from './compare.js';

// Spot/preemptible resume controller (pure decision logic)
export {
  isEvictionError,
  attemptSpendUsd,
  addAttempt,
  emptyBudget,
  decideRetry,
  deriveJobId,
} from './spot-resume.js';
export type { SpendAttempt, JobBudget, RetryDecision } from './spot-resume.js';

// Gateway + DI deps
export {
  FinetuneGateway,
  InMemoryFinetuneState,
  FileFinetuneState,
  EnvHfTokenResolver,
  resolveR2Creds,
} from './run.js';
export type {
  FinetuneStateStore,
  HfTokenResolver,
  GpuJobRunner,
  GpuJobRunnerOpts,
  GpuJobResult,
  FinetuneProbe,
  ResolvedFinetune,
  GatewayLogger,
  R2Creds,
} from './run.js';
