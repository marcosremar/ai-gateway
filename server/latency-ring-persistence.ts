// ── BabelCast Gateway — Latency Ring Buffer Persistence ─────────────────────
// The ring buffer is kept in-memory only. File-based persistence was removed
// because Fly.io machines have ephemeral storage (no persistent volumes).
// P95 metrics reset on restart, which is acceptable — they rebuild within
// a few minutes of traffic.

/** No-op: ring buffer is in-memory only. */
export function loadLatencyRing(): void {}

/** No-op: ring buffer is in-memory only. */
export function saveLatencyRing(): void {}
