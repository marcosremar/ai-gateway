/**
 * Finetune module — public types.
 * Single source of truth for all finetune-related interfaces.
 */

export type FinetuneType = 'text' | 'audio' | 'custom';
export type QualityMode = 'auto' | 'safe' | 'fast';
export type HfStructure = 'flat' | 'split' | 'tri';

// ─── Plugin system ─────────────────────────────────────────────────────────

export interface Plugin {
  name: string;
  description: string;
  extraDeps?: string;
  extraTrainArgs?: string;
  torchVersion?: string;
}

export const BUNDLED_PLUGINS: Record<string, Plugin> = {
  lora: {
    name: 'lora',
    description: 'Low-Rank Adaptation (LoRA) — train only adapter weights',
    extraDeps: 'peft',
    extraTrainArgs: '--use-lora',
  },
  qlora: {
    name: 'qlora',
    description: 'Quantized LoRA — 4-bit quantization + LoRA for memory efficiency',
    extraDeps: 'peft bitsandbytes',
    extraTrainArgs: '--use-lora --quantize-bits 4',
  },
  'grad-ckpt': {
    name: 'grad-ckpt',
    description: 'Gradient checkpointing — trade compute for VRAM',
    extraTrainArgs: '--gradient-checkpointing',
  },
  'flash-attn': {
    name: 'flash-attn',
    description: 'Flash Attention 2 — faster attention with lower memory',
    extraDeps: 'flash-attn',
    extraTrainArgs: '--use-flash-attn',
  },
};

// ─── Preset manifest ────────────────────────────────────────────────────────

export interface TrainerInterface {
  encode?: string;
  train: string;
  [key: string]: string | undefined;
}

export interface PresetManifest {
  name: string;
  version: string;
  description: string;
  type: FinetuneType;
  trainerScript: string;
  prepareScript?: string;
  tokenizerExtScript?: string;
  defaultModel?: string;
  defaultEpochs?: number;
  defaultLR?: number;
  defaultGpu?: string;
  defaultMaxSpend?: number;
  trainerInterface: TrainerInterface;
  aptDeps?: string;
  pipDeps?: string;
  torchCudaIndex?: string;
  torchVersion?: string;
  knownTags?: string[];
  notes?: string;
  // Decoupling pocket-tts hardcoding: presets opt-in to smoke verify + probe overrides.
  smokeVerify?: SmokeVerifySpec;
  preSmokeVerify?: SmokeVerifySpec;
  probePaths?: ProbePathsSpec;
  stagePatterns?: StageDetectorPatterns;
  /** Cost estimator hints. */
  defaultStepsPerSec?: number;
  defaultEncodeRatePerGpu?: number;
}

export interface Preset {
  manifest: PresetManifest;
  dir: string;
}

// ─── Project manifest ────────────────────────────────────────────────────────

/**
 * A project is a specific model+dataset+hyperparams config that references a
 * reusable preset. Presets contain the training algorithm; projects contain
 * the "what to train" specifics.
 *
 * Lives in finetune-projects/<name>/project.json
 */
export interface ProjectManifest {
  name: string;
  description: string;
  /** Preset directory name to use (e.g. "flow-matching-tts", "codec-tts"). */
  preset: string;
  /** HF model to fine-tune. Overrides preset defaultModel. */
  model?: string;
  /** Default dataset for this project. */
  defaultDataset?: string;
  defaultEpochs?: number;
  defaultLR?: number;
  defaultGpu?: string;
  defaultMaxSpend?: number;
  r2Bucket?: string;
  r2Prefix?: string;
  resumeFromR2?: boolean;
  r2ShardedRoot?: string;
  r2ShardedManifest?: string;
  r2BaseCkpt?: string;
  r2BaseVocab?: string;
  r2CkptDest?: string;
  r2SyncIntervalSec?: number;
  autoResumeR2?: boolean;
  shardCacheDir?: string;
  shardCacheMaxGb?: number;
  steps?: number;
  batchSize?: number;
  saveEverySteps?: number;
  logEverySteps?: number;
  workers?: number;
  evalEverySteps?: number;
  evalN?: number;
  evalAsrModel?: string;
  evalGateTarget?: number;
  earlyStopPatience?: number;
  hfSyncRepo?: string;
  hfSyncPath?: string;
  hfSyncIntervalSec?: number;
  skipSmoke?: boolean;
  encodeCmd?: string;
  trainCmd?: string;
  notes?: string;
}

export interface Project {
  manifest: ProjectManifest;
  dir: string;
}

// ─── Core finetune spec ────────────────────────────────────────────────────

export interface FinetuneOpts {
  // Identity — set type OR project, not both
  type: FinetuneType;
  /** Project name from finetune-projects/<name>/project.json. Resolves preset + injects defaults. */
  project?: string;
  scriptPath?: string;
  localPath?: string;

  // Data
  dataset?: string;
  datasetInclude?: string;
  model?: string;
  prepCmd?: string;

  // Encode / train override
  encodeCmd?: string;
  trainCmd?: string;

  // Training hyperparams
  epochs?: number;
  lr?: number;
  numGpus?: number;
  maxSamples?: number;

  // Budget / runtime
  gpu?: string;
  /** Optional provider region/geolocation filter, e.g. "Alberta, CA" for Vast. */
  region?: string;
  maxCost?: number;
  maxSpend?: number;
  output?: string;
  timeoutMin?: number;
  bootTimeoutMin?: number;
  bootTimeoutSec?: number;
  /** Deploy-level parallel race count. */
  raceCount?: number;
  /** Vast internal offer race knob. */
  offerRaceCount?: number;
  /** Vast strict/high-quality search; false allows broader SSH-only hosts. */
  strictFastBoot?: boolean;
  /** Vast offer search profile. */
  searchMode?: 'high_quality' | 'full';
  /** Allow unverified Vast hosts when searchMode is full. */
  allowUnverified?: boolean;
  /** Per-app deploy slot for concurrent finetune workers. */
  parallelSlot?: string;
  /** Remote instance storage size override in GB. */
  storageGb?: number;
  pullEveryMin?: number;
  stallMin?: number;
  pullExclude?: string[];

  // Quality / features
  quality?: QualityMode;
  torchCompile?: boolean;
  augmentPitch?: boolean;
  augmentSpeed?: boolean;
  autoStopPlateau?: number;
  saveEverySteps?: number;
  image?: string;

  // Tier 2 — power user
  batchSize?: number;
  gradAccum?: number;
  weightDecay?: number;
  warmupSteps?: number;
  freezeBackboneLayers?: number;
  onlyFlowNet?: boolean;
  curriculum?: 'linear' | '';
  seed?: number;
  gradClip?: number;
  logEverySteps?: number;
  autoLrRewind?: boolean;
  rewindThreshold?: number;
  plateauTolerance?: number;

  // Output / persistence
  pushToHf?: string;
  hfBase?: string;
  hfStructure?: HfStructure;
  fromHf?: string;
  ckptAverage?: number;
  exportGguf?: boolean;

  // R2 / S3 durable storage (independente de HF) — sobrevive morte do pod.
  /** Bucket R2/S3 p/ dataset + checkpoints. Liga restore/backup via rclone no script. */
  r2Bucket?: string;
  /** Prefix/pasta dentro do bucket (ex: jobs/tts-ptbr-v12). Default: jobs/<projeto-ou-preset>. */
  r2Prefix?: string;
  /** Ao subir, restaura /workspace/checkpoints do R2 e retoma o último step. */
  resumeFromR2?: boolean;
  /** Rclone root containing Route2 sharded NPY dataset. Example: r2aigw:bucket/path. */
  r2ShardedRoot?: string;
  /** Manifest JSONL for Route2 sharded dataset. */
  r2ShardedManifest?: string;
  /** Base checkpoint remote for Route2 fine-tune. */
  r2BaseCkpt?: string;
  /** Base phoneme vocab remote for Route2 fine-tune. */
  r2BaseVocab?: string;
  /** Checkpoint destination remote for Route2 periodic sync. */
  r2CkptDest?: string;
  /** Local bounded cache directory for R2 shard files. */
  shardCacheDir?: string;
  /** Max local shard cache size in GiB. */
  shardCacheMaxGb?: number;
  /** Step count for trainers that are step-based instead of epoch-based. */
  steps?: number;
  /** Dataloader workers for trainers that expose this knob. */
  workers?: number;
  /** Evaluate quality gate every N steps. */
  evalEverySteps?: number;
  /** Number of validation samples for each quality gate pass. */
  evalN?: number;
  /** ASR/Whisper model used by the validation gate. */
  evalAsrModel?: string;
  /** Target score for the validation gate. */
  evalGateTarget?: number;
  /** Stop after N gate passes without improvement, when trainer supports it. */
  earlyStopPatience?: number;
  /** Hugging Face repo for periodic checkpoint sync. */
  hfSyncRepo?: string;
  /** Path inside Hugging Face repo for checkpoint sync. */
  hfSyncPath?: string;
  /** Periodic Hugging Face checkpoint sync interval. */
  hfSyncIntervalSec?: number;
  /** Periodic R2/S3 checkpoint sync interval. 0 disables live sync; final sync still runs. */
  r2SyncIntervalSec?: number;
  /** Auto-restore checkpoints from R2/S3 when r2Bucket is set. Defaults to true. */
  autoResumeR2?: boolean;

  // Operations
  autoResume?: boolean;
  preferSpot?: boolean;
  /** Offer ranking for cost-sensitive GPU jobs. All modes still obey maxCost. */
  selectMode?: 'cheapest' | 'balanced' | 'fast';
  reuse?: boolean;
  dryRun?: boolean;
  smoke?: boolean;
  skipSmoke?: boolean;
  /** Safety override: allow skipping smoke even when estimated spend is high. */
  allowSkipSmokeForExpensive?: boolean;
  persistCache?: boolean;
  retryOnPreempt?: number;
  incremental?: boolean;
  autoFix?: boolean;
  plugin?: string;
  watchWer?: string;
  webDashboard?: boolean;

  // Integrations
  wandb?: { project: string; entity?: string; runName?: string; logModel?: 'checkpoint' | 'end' | 'none' };
  notifyOnComplete?: string;
  secrets?: Record<string, string>;

  // Infrastructure
  provider?: string;
  providers?: string[];
  failoverOnPreempt?: boolean;
  evalsPerEpoch?: number;
  earlyStopOnEval?: { metric: string; threshold: number };
  multiDataset?: Array<{ path: string; weight: number }>;

  // Advanced / internal
  extraTrainArgs?: string;
  extraDeps?: string;
  aptPkgs?: string;
  noHfTransfer?: boolean;
  prepare?: 'auto' | 'skip' | string;
  gpuFallback?: boolean;
  aigwVersion?: string;
  stepsPerSec?: number;          // cost estimator override
  sampleCount?: number;          // cost estimator override
  encodeRatePerGpu?: number;     // cost estimator override (samples/s)
}

// ─── Preset-driven smoke / probe (pluggable per workload) ────────────────

export interface SmokeVerifySpec {
  /** Inline python (single string). Run after smoke-train ckpt completes. */
  pythonInline?: string;
}

export interface ProbePathsSpec {
  /** Override default probe filesystem paths (pocket-tts defaults if absent). */
  wavDir?: string;
  dataPathsFile?: string;
  encodedFile?: string;
  encodedFullFile?: string;
  checkpointsDir?: string;
  smokeCheckpointsDir?: string;
  jobLog?: string;
}

export interface StageDetectorPatterns {
  /** Override default stage-detection regexes (pocket-tts defaults if absent). */
  encode?: string;   // regex source
  prepare?: string;
  train?: string;
  download?: string;
}

// ─── Job output (returned by status probe) ─────────────────────────────────

export type FinetuneStage =
  | 'downloading'
  | 'preparing'
  | 'encoding'
  | 'smoke-verify'
  | 'training'
  | 'pushing'
  | 'completed'
  | 'idle'
  | '?';

export interface FinetuneStatusResult {
  instanceId: string;
  gpuType: string;
  provider: string;
  pricePerHr: number;
  elapsedMin: number;
  spent: number;
  stage: FinetuneStage;
  stageDetail: string;
  gpuPct: number;
  vramUsedGb: number;
  vramTotalGb: number;
  wavCached: number;
  encodedPath?: string;
  checkpoints: string[];
  recentLoss: string[];
  step?: number;
  totalSteps?: number;
  bestScore?: number;
  lastScore?: number;
  lastEvalStep?: number;
}

// ─── Cost estimation ────────────────────────────────────────────────────────

export interface FinetuneCostEstimate {
  encodeMin: number;
  trainMin: number;
  setupMin: number;
  totalMin: number;
  totalUsd: number;
}

// ─── Dataset planning ──────────────────────────────────────────────────────

export type DatasetPrepComputeKind = 'cpu-fanout' | 'cheap-gpu' | 'selected-gpu';

export interface DatasetPrepOption {
  kind: DatasetPrepComputeKind;
  label: string;
  workers: number;
  samplesPerSec: number;
  pricePerHour: number;
  setupMin: number;
  totalMin: number;
  totalUsd: number;
  notes: string[];
}

export interface DatasetStoragePlan {
  provider: 'backblaze-b2' | 'cloudflare-r2' | 's3-compatible';
  bucket: string;
  prefix: string;
  datasetUri: string;
  manifestUri: string;
  exists: boolean;
  checked: boolean;
  checks: Array<{ target: string; ok: boolean; detail: string; bytes?: number }>;
}

export interface FinetunePlan {
  project?: string;
  type: FinetuneType | string;
  agent: 'minimax' | 'deterministic';
  dataset: {
    source?: string;
    sampleCount: number;
    maxSamples?: number;
    needsPreparation: boolean;
    validation: string[];
  };
  storage: DatasetStoragePlan | null;
  economics: {
    options: DatasetPrepOption[];
    recommended: DatasetPrepOption;
    reason: string;
  };
  training: FinetuneCostEstimate;
  blockers: string[];
  warnings: string[];
  nextSteps: string[];
  agentNotes?: string;
}

// ─── Validation result ──────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Run history record ────────────────────────────────────────────────────

export interface FinetuneRunRecord {
  id: string;
  ts: string;
  spec: Partial<FinetuneOpts>;
  instance: Record<string, unknown>;
}
