// ── Snapshot restore port ────────────────────────────────────────────────────
// The vast-vm and hyperstack strategies need to invoke `maybeRestoreSnapshot`
// (CRIU/cuda-checkpoint restore) which today lives in `server/gpu-snapshot.ts`.
// `src/` cannot import from `server/` (CI-enforced hard rule), so we expose a
// port here and let the server module register its implementation at startup.
//
// Strategies call `getSnapshotRestorer()` lazily; if no implementation has
// been registered, snapshot restore is silently skipped (returns
// { restored: false, reason: 'no restorer registered' }).

export interface SnapshotRestoreInput {
  provider: 'vast-vm' | 'hyperstack';
  ssh: { host: string; port: number };
  imageRef: string;
  imageDigest?: string;
  models: readonly string[];
  useCudaCheckpoint?: boolean;
}

export interface SnapshotRestoreOutput {
  restored: boolean;
  reason?: string;
  durationMs?: number;
  /** Free-form metadata describing the snapshot used, for diagnostics. */
  meta?: Record<string, unknown>;
}

export type SnapshotRestorer = (input: SnapshotRestoreInput) => Promise<SnapshotRestoreOutput>;

let _restorer: SnapshotRestorer | null = null;

/** Register the snapshot restorer implementation (called once from `server/`). */
export function registerSnapshotRestorer(fn: SnapshotRestorer): void {
  _restorer = fn;
}

export function getSnapshotRestorer(): SnapshotRestorer | null {
  return _restorer;
}
