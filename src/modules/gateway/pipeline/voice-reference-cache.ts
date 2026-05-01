// ── BabelCast Gateway — Voice Reference Cache ────────────────────────────────
// Stores uploaded reference audio + text in memory for voice cloning.
// Pipeline reads from cache using ref_id instead of sending 500KB on every request.

import { createLogger } from '../../logger';

const log = createLogger('voice-ref-cache');

interface VoiceReference {
  audio: string;
  text: string;
  createdAt: number;
}

const voiceRefCache = new Map<string, VoiceReference>();

/** Maximum number of voice references to keep in memory. */
const MAX_REFS = 5;

/**
 * Store a voice reference in the cache and return its ID.
 * Evicts oldest entries when cache exceeds MAX_REFS.
 */
export function storeVoiceReference(audio: string, text: string): string {
  const refId = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  voiceRefCache.set(refId, { audio, text, createdAt: Date.now() });

  // Clean old entries (keep last MAX_REFS)
  if (voiceRefCache.size > MAX_REFS) {
    const oldest = [...voiceRefCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < oldest.length - MAX_REFS; i++) voiceRefCache.delete(oldest[i][0]);
  }

  log.log(`Cached ref_id=${refId} audio=${(audio.length / 1024).toFixed(0)}KB text=${text.length} chars`);
  return refId;
}

/** Get cached voice reference by ID (used by pipeline). */
export function getVoiceReference(refId: string): { audio: string; text: string } | null {
  return voiceRefCache.get(refId) || null;
}

/** Clear all cached references. */
export function clearVoiceReferences(): void {
  voiceRefCache.clear();
}

/** Get current cache size (for diagnostics). */
export function getVoiceReferenceCacheSize(): number {
  return voiceRefCache.size;
}
