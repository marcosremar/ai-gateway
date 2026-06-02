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
  DatasetPrepOption,
  DatasetStoragePlan,
  FinetunePlan,
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

export {
  DEFAULT_VAST_SSH_BOOT_TIMEOUT_SEC,
  resolveVastSshAcquisitionPolicy,
} from './acquisition.js';
export type { VastSshAcquisitionPolicy, VastSshAcquisitionPolicyInput } from './acquisition.js';

export {
  defaultProviderCooldownsPath,
  formatCooldownSeconds,
  formatProviderCooldown,
  legacyProviderCooldownsPath,
  normalizeProviderName,
  parseActiveProviderCooldowns,
  parseProviderList,
  readActiveProviderCooldowns,
} from './provider-cooldowns.js';
export type { ActiveProviderCooldown, ActiveProviderCooldowns } from './provider-cooldowns.js';

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

// Dataset prep + cost planner
export { buildFinetunePlan, parseRcloneUri } from './planner.js';
export type { FinetunePlannerDeps, FinetunePlanOptions } from './planner.js';

// Fail-fast preflight (live HF/R2/script checks before GPU spend)
export { preflightChecks } from './preflight.js';
export type { PreflightCheck, PreflightResult, PreflightStatus, PreflightDeps } from './preflight.js';

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

// CPU-only Kokoro TTS dataset preparation fanout.
export {
  KOKORO_DATASET_DEFAULTS,
  buildKokoroDatasetPlan,
  buildKokoroWorkerScript,
  encodeShardJsonl,
  formatKokoroDatasetPlan,
  generatePhrasesWithGateway,
  generatePortugueseTemplatePhrases,
  loadKokoroDatasetPhrases,
  parseGatewayPhraseList,
  r2ToS3Uri,
  runKokoroDatasetFanout,
  shardKokoroPhrases,
  validateKokoroRunRequest,
} from './kokoro-dataset.js';
export type {
  DaytonaLike,
  KokoroDatasetPlan,
  KokoroDatasetRequest,
  KokoroDatasetRunRequest,
  KokoroDatasetRunResult,
  KokoroDatasetShard,
  KokoroPhrase,
} from './kokoro-dataset.js';

// Gateway + DI deps
export {
  FinetuneGateway,
  InMemoryFinetuneState,
  FileFinetuneState,
  EnvHfTokenResolver,
  resolveR2Creds,
} from './run.js';

export {
  createFinetuneJobRecord,
  deriveFinetuneHttpStatus,
  finetuneJobsRoot,
  cliJobStatePath,
  listFinetuneJobRecords,
  loadFinetuneJobRecord,
  loadLatestFinetuneJobRecord,
  normalizeFinetuneHttpSpec,
  readFinetuneJobLogs,
  safeJobId,
  updateFinetuneJobRecord,
} from './jobs.js';

export type {
  FinetuneHttpStatus,
  FinetuneJobLifecycle,
  FinetuneJobRecord,
} from './jobs.js';
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
