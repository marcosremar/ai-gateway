/**
 * GPU Deploy Settings — persisted configuration for GPU deployment.
 *
 * Manages: GPU priority lists (global + per-provider), selection criteria,
 * deploy timeout, preferred region, and latency probe threshold.
 *
 * Persisted to ~/.babelcast/latency-settings.json
 */

import os from 'os';
import path from 'path';
import fs from 'fs';

const configDir = process.env.AI_GATEWAY_CONFIG_DIR || path.join(os.homedir(), '.ai-gateway');
const SETTINGS_PATH = path.join(configDir, 'latency-settings.json');

// ── GPU Priority Defaults ────────────────────────────────────────────────────

// Default GPU priority — ordered by performance/cost for Whisper + 12B LLM inference.
export const DEFAULT_GPU_PRIORITY: string[] = [
  'NVIDIA GeForce RTX 5090', // ~150 tok/s, 32GB GDDR7, Blackwell
  'NVIDIA H200', // 141GB HBM3e, Hopper, best for 70B+ models
  'NVIDIA L40S', // ~114 tok/s, 48GB VRAM
  'NVIDIA H100 80GB HBM3', // 80GB HBM3, Hopper, data center
  'NVIDIA GeForce RTX 4090', // ~110 tok/s, 24GB VRAM, widely available
  'NVIDIA RTX A6000', // ~102 tok/s, 48GB VRAM, stable
  'NVIDIA A100-SXM4-80GB', // ~135 tok/s, 80GB VRAM
  'NVIDIA A100 80GB PCIe', // tested — 80GB VRAM
  // RTX 5080 removed — Blackwell hosts consistently have direct_port_end: -1 (no NAT forwarding)
  'NVIDIA A40', // 48GB VRAM, backup
];

// Per-provider defaults — each provider has different GPU availability.
export const DEFAULT_GPU_PRIORITY_BY_PROVIDER: Record<string, string[]> = {
  vast: [...DEFAULT_GPU_PRIORITY], // Vast has the widest GPU selection
  runpod: [
    // RunPod Secure Cloud — data center GPUs
    'NVIDIA GeForce RTX 5090',
    'NVIDIA H200',
    'NVIDIA H100 80GB HBM3',
    'NVIDIA RTX A6000',
    'NVIDIA L40S',
    'NVIDIA A100-SXM4-80GB',
    'NVIDIA A100 80GB PCIe',
    'NVIDIA GeForce RTX 4090',
    'NVIDIA A40',
  ],
  tensordock: [
    // TensorDock bare metal marketplace
    'NVIDIA GeForce RTX 5090',
    'NVIDIA GeForce RTX 4090',
    'NVIDIA RTX A6000',
    'NVIDIA A40',
    'NVIDIA L40S',
  ],
};

// ── Settings Interface ───────────────────────────────────────────────────────

export type GpuSortBy = 'price' | 'latency' | 'balanced' | 'realtime';

interface DeploySettings {
  intervalMin: number; // latency probe interval in minutes
  lastRunAt: number; // ms timestamp of last probe cycle
  maxLatencyMs: number; // deploy threshold (0 = disabled)
  gpuPriorityList: string[]; // global GPU priority fallback
  gpuPriorityByProvider: Record<string, string[]>; // per-provider GPU priority overrides
  gpuSortBy: GpuSortBy; // offer selection criteria
  deployTimeoutMin: number; // max wait per provider (min 3, max 60)
  deployRegion: string; // region filter ('' = any, 'EU', 'US', 'AP', …)
  deployDockerImage: string; // last-used Docker image (persisted across reloads)
  minVramGb: number; // minimum VRAM filter in GB (0 = any)
  minDiskGb: number; // minimum disk space in GB (default 100)
  preferSsd: boolean; // prefer SSD/NVMe over HDD (diskBwRead > 200 MB/s)
  sttTargetLatencyMs: number; // per-service max latency for STT
  llmTargetLatencyMs: number; // per-service max latency for LLM/translate
  ttsTargetLatencyMs: number; // per-service max latency for TTS
  benchmarkMaxRuns: number; // max attempts per service before repechage (default 20)
  benchmarkMarginPct: number; // % below target required to pass (default 10)
  shadowRuns: number; // shadow mode rounds before production activation (default 5)
  p95DemotionMultiplier: number; // demote GPU when P95 > target × this multiplier (default 2.0)
  p95IdleWindowSec: number; // only check P95 demotion when idle for this long (default 10)
  repechageMaxAttempts: number; // max repechage attempts before condemning GPU (default 3)
  standbyEnabled: boolean; // default false — opt-in secondary GPU standby
  standbyTriggerHours: number; // default 4 — trigger standby after N hours of session
  standbyDrainTimeoutMs: number; // default 30000 — max drain window ms before force handover
  deployRaceCount: number; // hedged deploy: launch N instances in parallel, keep first healthy (1 = off)
  autoRecoveryEnabled: boolean; // auto-deploy replacement when GPU condemned (default true)
  autoRecoveryDelaySec: number; // seconds to wait before auto-recovery deploy (default 10)
  autoRecoveryMaxRetries: number; // max auto-recovery attempts before giving up (default 2)
}

const DEFAULTS: DeploySettings = {
  intervalMin: 120,
  lastRunAt: 0,
  maxLatencyMs: 100,
  gpuPriorityList: [...DEFAULT_GPU_PRIORITY],
  gpuPriorityByProvider: { ...DEFAULT_GPU_PRIORITY_BY_PROVIDER },
  gpuSortBy: 'balanced',
  deployTimeoutMin: 30,
  deployRegion: '',
  deployDockerImage: '',
  minVramGb: 16,
  minDiskGb: 20, // was 100 — caused ghost machines on RunPod (no host has 200GB free)
  preferSsd: false,
  sttTargetLatencyMs: 800,
  llmTargetLatencyMs: 2000,
  ttsTargetLatencyMs: 1500,
  benchmarkMaxRuns: 20,
  benchmarkMarginPct: 10,
  shadowRuns: 5,
  p95DemotionMultiplier: 2.0,
  p95IdleWindowSec: 10,
  repechageMaxAttempts: 3,
  standbyEnabled: false,
  standbyTriggerHours: 4,
  standbyDrainTimeoutMs: 30_000,
  deployRaceCount: 1, // RunPod SECURE is reliable; race only needed for Vast.ai (set to 2)
  autoRecoveryEnabled: true,
  autoRecoveryDelaySec: 10,
  autoRecoveryMaxRetries: 2,
};

let _s: DeploySettings = {
  ...DEFAULTS,
  gpuPriorityList: [...DEFAULT_GPU_PRIORITY],
  gpuPriorityByProvider: { ...DEFAULT_GPU_PRIORITY_BY_PROVIDER },
};

// ── Persistence ──────────────────────────────────────────────────────────────

export function loadDeploySettings(): void {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DeploySettings>;
    _s = { ..._s, ...parsed };
    if (!Array.isArray(_s.gpuPriorityList) || _s.gpuPriorityList.length === 0) {
      _s.gpuPriorityList = [...DEFAULT_GPU_PRIORITY];
    }
    if (!_s.gpuPriorityByProvider || typeof _s.gpuPriorityByProvider !== 'object') {
      _s.gpuPriorityByProvider = { ...DEFAULT_GPU_PRIORITY_BY_PROVIDER };
    }
    if (!(['price', 'latency', 'balanced', 'realtime'] as string[]).includes(_s.gpuSortBy)) {
      _s.gpuSortBy = 'balanced';
    }
    if (typeof _s.deployTimeoutMin !== 'number' || _s.deployTimeoutMin < 3) {
      _s.deployTimeoutMin = 30;
    }
  } catch {
    /* use defaults */
  }
}

// Debounced save — batches rapid config changes (e.g. slider drags) into one disk write
let _settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function saveDeploySettings(): void {
  if (_settingsSaveTimer) clearTimeout(_settingsSaveTimer);
  _settingsSaveTimer = setTimeout(() => {
    _settingsSaveTimer = null;
    try {
      const dir = path.dirname(SETTINGS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(_s, null, 2));
    } catch {
      /* ignore */
    }
  }, 300);
}

/** Force immediate save (for shutdown hooks) */
export function flushDeploySettings(): void {
  if (_settingsSaveTimer) {
    clearTimeout(_settingsSaveTimer);
    _settingsSaveTimer = null;
  }
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(_s, null, 2));
  } catch {
    /* ignore */
  }
}

// ── Raw settings snapshot (for scheduler status) ─────────────────────────────

export function getDeploySettingsSnapshot(): Omit<DeploySettings, never> {
  return { ..._s };
}

export function setLastRunAt(ts: number): void {
  _s.lastRunAt = ts;
  saveDeploySettings();
}

// ── Probe schedule ────────────────────────────────────────────────────────────

export function getLatencyIntervalMin(): number {
  return _s.intervalMin;
}

export function setLatencyIntervalMin(intervalMin: number): void {
  _s.intervalMin = intervalMin;
  saveDeploySettings();
}

export function getLatencyMaxMs(): number {
  return _s.maxLatencyMs;
}

export function setLatencyMaxMs(maxLatencyMs: number): void {
  _s.maxLatencyMs = maxLatencyMs;
  saveDeploySettings();
}

// ── GPU Priority ──────────────────────────────────────────────────────────────

export function getGpuPriorityList(): string[] {
  return _s.gpuPriorityList;
}

export function setGpuPriorityList(list: string[]): void {
  _s.gpuPriorityList = list.length > 0 ? list : [...DEFAULT_GPU_PRIORITY];
  saveDeploySettings();
}

export function getDefaultGpuPriority(): string[] {
  return [...DEFAULT_GPU_PRIORITY];
}

export function getGpuPriorityForProvider(provider: string): string[] {
  return _s.gpuPriorityByProvider?.[provider] ?? _s.gpuPriorityList;
}

export function setGpuPriorityForProvider(provider: string, list: string[]): void {
  if (!_s.gpuPriorityByProvider) _s.gpuPriorityByProvider = {};
  _s.gpuPriorityByProvider[provider] =
    list.length > 0
      ? list
      : [...(DEFAULT_GPU_PRIORITY_BY_PROVIDER[provider] ?? DEFAULT_GPU_PRIORITY)];
  saveDeploySettings();
}

export function getDefaultGpuPriorityByProvider(): Record<string, string[]> {
  return { ...DEFAULT_GPU_PRIORITY_BY_PROVIDER };
}

// ── Selection Criteria ────────────────────────────────────────────────────────

export function getGpuSortBy(): GpuSortBy {
  return _s.gpuSortBy;
}

export function setGpuSortBy(sortBy: GpuSortBy): void {
  _s.gpuSortBy = sortBy;
  saveDeploySettings();
}

// ── Deploy Timeout ────────────────────────────────────────────────────────────

export function getDeployTimeoutMin(): number {
  return _s.deployTimeoutMin;
}

export function setDeployTimeoutMin(min: number): void {
  _s.deployTimeoutMin = Math.max(3, Math.min(60, min));
  saveDeploySettings();
}

// ── Deploy Region ─────────────────────────────────────────────────────────────

export function getDeployRegion(): string {
  return _s.deployRegion;
}

export function setDeployRegion(region: string): void {
  _s.deployRegion = region;
  saveDeploySettings();
}

// ── Deploy Docker Image ───────────────────────────────────────────────────────

export function getDeployDockerImage(): string {
  return _s.deployDockerImage;
}

export function setDeployDockerImage(image: string): void {
  _s.deployDockerImage = image;
  saveDeploySettings();
}

// ── Hardware Filters ──────────────────────────────────────────────────────────

export function getMinVramGb(): number {
  return _s.minVramGb;
}

export function setMinVramGb(gb: number): void {
  _s.minVramGb = Math.max(0, gb);
  saveDeploySettings();
}

export function getMinDiskGb(): number {
  return _s.minDiskGb ?? 100;
}

export function setMinDiskGb(gb: number): void {
  _s.minDiskGb = Math.max(0, gb);
  saveDeploySettings();
}

export function getPreferSsd(): boolean {
  return _s.preferSsd;
}

export function setPreferSsd(v: boolean): void {
  _s.preferSsd = v;
  saveDeploySettings();
}

// ── Per-Service Readiness Target Latency ─────────────────────────────────────

export function getSttTargetLatencyMs(): number {
  return _s.sttTargetLatencyMs;
}
export function setSttTargetLatencyMs(ms: number): void {
  _s.sttTargetLatencyMs = Math.max(100, Math.min(10_000, ms));
  saveDeploySettings();
}

export function getLlmTargetLatencyMs(): number {
  return _s.llmTargetLatencyMs;
}
export function setLlmTargetLatencyMs(ms: number): void {
  _s.llmTargetLatencyMs = Math.max(200, Math.min(30_000, ms));
  saveDeploySettings();
}

export function getTtsTargetLatencyMs(): number {
  return _s.ttsTargetLatencyMs;
}
export function setTtsTargetLatencyMs(ms: number): void {
  _s.ttsTargetLatencyMs = Math.max(100, Math.min(15_000, ms));
  saveDeploySettings();
}

export function getBenchmarkMaxRuns(): number {
  return _s.benchmarkMaxRuns;
}
export function setBenchmarkMaxRuns(n: number): void {
  _s.benchmarkMaxRuns = Math.max(3, Math.min(50, n));
  saveDeploySettings();
}

export function getBenchmarkMarginPct(): number {
  return _s.benchmarkMarginPct;
}
export function setBenchmarkMarginPct(pct: number): void {
  _s.benchmarkMarginPct = Math.max(0, Math.min(50, pct));
  saveDeploySettings();
}

export function getShadowRuns(): number {
  return _s.shadowRuns;
}
export function setShadowRuns(n: number): void {
  _s.shadowRuns = Math.max(1, Math.min(20, n));
  saveDeploySettings();
}

// ── P95 Demotion & Repechage ──────────────────────────────────────────────────

export function getP95DemotionMultiplier(): number {
  return _s.p95DemotionMultiplier ?? 2.0;
}
export function setP95DemotionMultiplier(v: number): void {
  _s.p95DemotionMultiplier = Math.max(1.5, Math.min(5, v));
  saveDeploySettings();
}

export function getP95IdleWindowSec(): number {
  return _s.p95IdleWindowSec ?? 10;
}
export function setP95IdleWindowSec(v: number): void {
  _s.p95IdleWindowSec = Math.max(1, Math.min(300, v));
  saveDeploySettings();
}

export function getRepechageMaxAttempts(): number {
  return _s.repechageMaxAttempts ?? 3;
}
export function setRepechageMaxAttempts(v: number): void {
  _s.repechageMaxAttempts = Math.max(1, Math.min(10, v));
  saveDeploySettings();
}

// ── Secondary GPU Standby ─────────────────────────────────────────────────────

export function getStandbyEnabled(): boolean {
  return _s.standbyEnabled ?? false;
}
export function setStandbyEnabled(v: boolean): void {
  _s.standbyEnabled = v;
  saveDeploySettings();
}

export function getStandbyTriggerHours(): number {
  return _s.standbyTriggerHours ?? 4;
}
export function setStandbyTriggerHours(h: number): void {
  _s.standbyTriggerHours = Math.max(0.5, Math.min(24, h));
  saveDeploySettings();
}

export function getStandbyDrainTimeoutMs(): number {
  return _s.standbyDrainTimeoutMs ?? 30_000;
}
export function setStandbyDrainTimeoutMs(ms: number): void {
  _s.standbyDrainTimeoutMs = Math.max(5_000, Math.min(120_000, ms));
  saveDeploySettings();
}

// ── Hedged Deploy (Race Count) ────────────────────────────────────────────────

export function getDeployRaceCount(): number {
  return _s.deployRaceCount ?? 1;
}
export function setDeployRaceCount(n: number): void {
  _s.deployRaceCount = Math.max(1, Math.min(10, Math.floor(n)));
  saveDeploySettings();
}

// ── Auto-Recovery on Condemnation ─────────────────────────────────────────────

export function getAutoRecoveryEnabled(): boolean {
  return _s.autoRecoveryEnabled ?? true;
}
export function setAutoRecoveryEnabled(v: boolean): void {
  _s.autoRecoveryEnabled = v;
  saveDeploySettings();
}

export function getAutoRecoveryDelaySec(): number {
  return _s.autoRecoveryDelaySec ?? 10;
}
export function setAutoRecoveryDelaySec(v: number): void {
  _s.autoRecoveryDelaySec = Math.max(5, Math.min(300, v));
  saveDeploySettings();
}

export function getAutoRecoveryMaxRetries(): number {
  return _s.autoRecoveryMaxRetries ?? 2;
}
export function setAutoRecoveryMaxRetries(v: number): void {
  _s.autoRecoveryMaxRetries = Math.max(0, Math.min(10, v));
  saveDeploySettings();
}

// ── GPU Type Fallback Chain ──────────────────────────────────────────────

/**
 * Get fallback GPU types when the primary GPU type is unavailable or fails.
 *
 * Returns alternatives ordered by similarity (VRAM, performance tier).
 * Used by the deploy orchestrator to retry with different GPU types
 * when the preferred type is out of stock or has persistent failures.
 */
export function getGpuFallbacks(failedGpuType: string): string[] {
  const FALLBACK_MAP: Record<string, string[]> = {
    'NVIDIA GeForce RTX 4090': ['NVIDIA RTX A6000', 'NVIDIA L40S', 'NVIDIA A40'],
    'NVIDIA RTX A6000': ['NVIDIA L40S', 'NVIDIA A40', 'NVIDIA GeForce RTX 4090'],
    'NVIDIA L40S': ['NVIDIA RTX A6000', 'NVIDIA A40'],
    'NVIDIA A40': ['NVIDIA RTX A6000', 'NVIDIA L40S'],
    'NVIDIA GeForce RTX 3090': ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000'],
    'NVIDIA GeForce RTX 5090': ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000'],
    'NVIDIA H100 80GB HBM3': ['NVIDIA H200', 'NVIDIA A100-SXM4-80GB', 'NVIDIA A100 80GB PCIe'],
    'NVIDIA H200': ['NVIDIA H100 80GB HBM3', 'NVIDIA A100-SXM4-80GB'],
    'NVIDIA A100-SXM4-80GB': ['NVIDIA A100 80GB PCIe', 'NVIDIA H100 80GB HBM3', 'NVIDIA L40S'],
    'NVIDIA A100 80GB PCIe': ['NVIDIA A100-SXM4-80GB', 'NVIDIA H100 80GB HBM3', 'NVIDIA L40S'],
  };
  return FALLBACK_MAP[failedGpuType] || [];
}

// ── Known-Bad Configuration Warnings ─────────────────────────────────────────

export interface DeployWarning {
  level: 'warn' | 'error';
  message: string;
}

/**
 * Check deploy configuration for known-bad combinations that are likely
 * to cause failures (OOM, CUDA incompatibility, disk exhaustion, etc.).
 *
 * Returns an array of warnings/errors. Empty array = no issues detected.
 */
export function checkDeployWarnings(opts: {
  dockerImage?: string;
  gpuTypes?: string[];
  onstart?: string;
  storageGb?: number;
}): DeployWarning[] {
  const warnings: DeployWarning[] = [];
  const img = (opts.dockerImage || '').toLowerCase();
  const onstart = (opts.onstart || '').toLowerCase();
  const hints = img + ' ' + onstart;

  // Blackwell GPUs need CUDA 12.8+
  if (opts.gpuTypes?.some(g => /5090|5080/i.test(g)) && /cuda.?12\.[0-4]/i.test(img)) {
    warnings.push({
      level: 'error',
      message: 'Blackwell GPUs (5090/5080) require CUDA 12.8+ but image appears to use older CUDA',
    });
  }

  // vLLM with large models on small GPUs (24GB VRAM)
  if (/70b|65b|72b/i.test(hints) && opts.gpuTypes?.every(g => /3090|4090|3080|4080|3070/i.test(g))) {
    warnings.push({
      level: 'error',
      message: '70B+ models need 48GB+ VRAM. RTX 3090/4090 (24GB) will OOM. Use A6000, L40S, or A100.',
    });
  }

  // 32B+ models on GPUs with <24GB VRAM
  if (/32b|34b|33b/i.test(hints) && opts.gpuTypes?.every(g => /3080|4080|3070|3060|4070/i.test(g))) {
    warnings.push({
      level: 'error',
      message: '32B models need 24GB+ VRAM. This GPU has insufficient VRAM.',
    });
  }

  // Low disk for large models
  if (/70b/i.test(hints) && (opts.storageGb || 0) > 0 && (opts.storageGb || 0) < 150) {
    warnings.push({
      level: 'warn',
      message: '70B models need ~200GB disk. Consider increasing storageGb.',
    });
  }

  return warnings;
}
