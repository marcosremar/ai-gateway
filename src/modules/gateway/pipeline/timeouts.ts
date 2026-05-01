// ── BabelCast Gateway — Pipeline Timeout Constants ───────────────────────────
// Real-time timeout constants tuned for subtitle pipeline.
// Anything above these thresholds has lost its utility for real-time display
// and should yield to the next provider.

// STT needs extra headroom: auto-swap sends 3 parallel requests that queue
// on the GPU (serialized by GPU semaphore), so worst-case is ~3x single latency.
export const GPU_STT_TIMEOUT_MS = 5_000;
export const GPU_LLM_TIMEOUT_MS = 3_000;
export const GPU_TTS_TIMEOUT_MS = 5_000;
export const GPU_PIPELINE_TIMEOUT_MS = 6_000;
