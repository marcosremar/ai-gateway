/**
 * Labs Feature Flags — persisted experimental feature toggles.
 *
 * Manages: PeakEWMA load balancing, speculative translation,
 * streaming pipeline overlap, and their tuning parameters.
 *
 * Persisted to ~/.babelcast/labs-settings.json
 */

import os from 'os';
import path from 'path';
import { readFile, writeFile, mkdir, access } from 'fs/promises';

const SETTINGS_PATH = path.join(os.homedir(), '.babelcast', 'labs-settings.json');

// ── Labs Flags Interface ────────────────────────────────────────────────────

export interface LabsFlags {
  peakEwma: boolean;                  // PeakEWMA load balancing
  speculativeTranslation: boolean;    // Start translating partial ASR
  streamingOverlap: boolean;          // Pipeline stage overlap (start TTS before LLM finishes)
  // Tuning parameters
  ewmaDecayFactor: number;            // 0.0-1.0, default 0.3 (how fast old observations decay)
  speculationMinConfidence: number;   // 0.0-1.0, default 0.7 (min ASR confidence to speculate)
  overlapMinTokens: number;           // default 3 (min LLM tokens before starting TTS)
  // Proactive idle stop — auto-stop pods when budget usage exceeds threshold
  proactiveIdleStop: boolean;         // When budget > threshold%, auto-stop pods idle > N min (default: false)
  proactiveIdleThresholdPct: number;  // Budget % threshold to trigger proactive idle stop (default: 75)
  proactiveIdleMinutes: number;       // Minutes idle before auto-stop when over budget threshold (default: 5)
  updatedAt: number;
}

const DEFAULTS: LabsFlags = {
  peakEwma: false,
  speculativeTranslation: false,
  streamingOverlap: false,
  ewmaDecayFactor: 0.3,
  speculationMinConfidence: 0.7,
  overlapMinTokens: 3,
  proactiveIdleStop: false,
  proactiveIdleThresholdPct: 75,
  proactiveIdleMinutes: 5,
  updatedAt: 0,
};

let _s: Readonly<LabsFlags> = Object.freeze({ ...DEFAULTS });

// ── Persistence ──────────────────────────────────────────────────────────────

export async function loadLabsSettings(): Promise<void> {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LabsFlags>;
    const merged: LabsFlags = { ..._s, ...parsed };
    // Validate booleans
    if (typeof merged.peakEwma !== 'boolean') merged.peakEwma = false;
    if (typeof merged.speculativeTranslation !== 'boolean') merged.speculativeTranslation = false;
    if (typeof merged.streamingOverlap !== 'boolean') merged.streamingOverlap = false;
    if (typeof merged.proactiveIdleStop !== 'boolean') merged.proactiveIdleStop = false;
    // Validate numeric ranges
    if (typeof merged.ewmaDecayFactor !== 'number' || merged.ewmaDecayFactor < 0 || merged.ewmaDecayFactor > 1) {
      merged.ewmaDecayFactor = 0.3;
    }
    if (typeof merged.speculationMinConfidence !== 'number' || merged.speculationMinConfidence < 0 || merged.speculationMinConfidence > 1) {
      merged.speculationMinConfidence = 0.7;
    }
    if (typeof merged.overlapMinTokens !== 'number' || merged.overlapMinTokens < 1) {
      merged.overlapMinTokens = 3;
    }
    if (typeof merged.proactiveIdleThresholdPct !== 'number' || merged.proactiveIdleThresholdPct < 1 || merged.proactiveIdleThresholdPct > 100) {
      merged.proactiveIdleThresholdPct = 75;
    }
    if (typeof merged.proactiveIdleMinutes !== 'number' || merged.proactiveIdleMinutes < 1 || merged.proactiveIdleMinutes > 60) {
      merged.proactiveIdleMinutes = 5;
    }
    _s = Object.freeze(merged);
  } catch { /* use defaults */ }
}

export async function saveLabsSettings(): Promise<void> {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    let dirExists: boolean;
    try {
      await access(dir);
      dirExists = true;
    } catch {
      dirExists = false;
    }
    if (!dirExists) await mkdir(dir, { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify(_s, null, 2));
  } catch { /* ignore */ }
}

// ── Accessors ────────────────────────────────────────────────────────────────

/** Returns the current labs flags. The returned object is frozen (read-only)
 *  to avoid accidental mutation — no shallow copy overhead per call. */
export function getLabsFlags(): Readonly<LabsFlags> {
  return _s;
}

export async function setLabsFlags(partial: Partial<LabsFlags>): Promise<Readonly<LabsFlags>> {
  const updated: LabsFlags = { ..._s };
  // Merge booleans
  if (typeof partial.peakEwma === 'boolean') updated.peakEwma = partial.peakEwma;
  if (typeof partial.speculativeTranslation === 'boolean') updated.speculativeTranslation = partial.speculativeTranslation;
  if (typeof partial.streamingOverlap === 'boolean') updated.streamingOverlap = partial.streamingOverlap;
  if (typeof partial.proactiveIdleStop === 'boolean') updated.proactiveIdleStop = partial.proactiveIdleStop;

  // Merge numeric tuning parameters with clamping
  if (typeof partial.ewmaDecayFactor === 'number') {
    updated.ewmaDecayFactor = Math.max(0, Math.min(1, partial.ewmaDecayFactor));
  }
  if (typeof partial.speculationMinConfidence === 'number') {
    updated.speculationMinConfidence = Math.max(0, Math.min(1, partial.speculationMinConfidence));
  }
  if (typeof partial.overlapMinTokens === 'number') {
    updated.overlapMinTokens = Math.max(1, Math.min(10, Math.floor(partial.overlapMinTokens)));
  }
  if (typeof partial.proactiveIdleThresholdPct === 'number') {
    updated.proactiveIdleThresholdPct = Math.max(1, Math.min(100, Math.floor(partial.proactiveIdleThresholdPct)));
  }
  if (typeof partial.proactiveIdleMinutes === 'number') {
    updated.proactiveIdleMinutes = Math.max(1, Math.min(60, Math.floor(partial.proactiveIdleMinutes)));
  }

  updated.updatedAt = Date.now();
  _s = Object.freeze(updated);
  await saveLabsSettings();
  return _s;
}
