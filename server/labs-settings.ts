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
import fs from 'fs';

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
  updatedAt: number;
}

const DEFAULTS: LabsFlags = {
  peakEwma: false,
  speculativeTranslation: false,
  streamingOverlap: false,
  ewmaDecayFactor: 0.3,
  speculationMinConfidence: 0.7,
  overlapMinTokens: 3,
  updatedAt: 0,
};

let _s: Readonly<LabsFlags> = Object.freeze({ ...DEFAULTS });

// ── Persistence ──────────────────────────────────────────────────────────────

export function loadLabsSettings(): void {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LabsFlags>;
    const merged: LabsFlags = { ..._s, ...parsed };
    // Validate booleans
    if (typeof merged.peakEwma !== 'boolean') merged.peakEwma = false;
    if (typeof merged.speculativeTranslation !== 'boolean') merged.speculativeTranslation = false;
    if (typeof merged.streamingOverlap !== 'boolean') merged.streamingOverlap = false;
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
    _s = Object.freeze(merged);
  } catch { /* use defaults */ }
}

export function saveLabsSettings(): void {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(_s, null, 2));
  } catch { /* ignore */ }
}

// ── Accessors ────────────────────────────────────────────────────────────────

/** Returns the current labs flags. The returned object is frozen (read-only)
 *  to avoid accidental mutation — no shallow copy overhead per call. */
export function getLabsFlags(): Readonly<LabsFlags> {
  return _s;
}

export function setLabsFlags(partial: Partial<LabsFlags>): Readonly<LabsFlags> {
  const updated: LabsFlags = { ..._s };
  // Merge booleans
  if (typeof partial.peakEwma === 'boolean') updated.peakEwma = partial.peakEwma;
  if (typeof partial.speculativeTranslation === 'boolean') updated.speculativeTranslation = partial.speculativeTranslation;
  if (typeof partial.streamingOverlap === 'boolean') updated.streamingOverlap = partial.streamingOverlap;

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

  updated.updatedAt = Date.now();
  _s = Object.freeze(updated);
  saveLabsSettings();
  return _s;
}
