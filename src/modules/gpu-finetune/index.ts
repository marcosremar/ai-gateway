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
  loadPreset, listPresets, setPresetsRoot,
  loadProject, listProjects, setProjectsRoot, resolveProjectOpts,
  runNumericChecks,
} from './spec.js';
export type { NumericCheckResult } from './spec.js';

// Cost estimation
export { estimateCost } from './cost.js';

// Status / probe
export { parseProbeOutput, detectStage, buildStatusResult, buildProbeCommand } from './status.js';
export type { ProbeOutput } from './status.js';

// Compare
export { runCompare, parseCompareOutput } from './compare.js';
export type { CompareOpts, CompareResult, CompareRow } from './compare.js';

// Gateway + DI deps
export {
  FinetuneGateway,
  InMemoryFinetuneState,
  FileFinetuneState,
  EnvHfTokenResolver,
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
} from './run.js';
