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
  maxCost?: number;
  maxSpend?: number;
  output?: string;

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

  // Operations
  autoResume?: boolean;
  preferSpot?: boolean;
  reuse?: boolean;
  dryRun?: boolean;
  smoke?: boolean;
  skipSmoke?: boolean;
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
}

// ─── Cost estimation ────────────────────────────────────────────────────────

export interface FinetuneCostEstimate {
  encodeMin: number;
  trainMin: number;
  setupMin: number;
  totalMin: number;
  totalUsd: number;
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
