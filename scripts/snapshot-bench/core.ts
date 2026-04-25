/**
 * Pure helpers for the cross-VM snapshot benchmark.
 *
 * Kept free of IO (no fs, no child_process, no fetch) so it can be unit-tested
 * without any network or shell. The bench script imports these and glues them
 * together with Hyperstack / SSH IO.
 */

// ── Timing bag ──────────────────────────────────────────────────────────────

/** All phase timings the bench collects. Every field is optional so partial
 *  runs (crash halfway through capture, etc.) still serialize cleanly. */
export interface BenchTimings {
  // Capture phase (VM_A)
  vm_a_boot_ms?: number;
  vm_a_tools_install_ms?: number;
  cold_load_ms?: number;
  toggle_drain_ms?: number;
  dump_ms?: number;
  compress_ms?: number;
  compressed_size_bytes?: number;
  upload_ms?: number;
  vm_a_terminate_ms?: number;

  // Restore phase (VM_B)
  vm_b_boot_ms?: number;
  vm_b_tools_install_ms?: number;
  download_ms?: number;
  downloaded_size_bytes?: number;
  decompress_ms?: number;
  restore_ms?: number;
  toggle_restore_ms?: number;
  vm_b_terminate_ms?: number;
}

export interface BenchModelMeta {
  /** HuggingFace model id, e.g. "microsoft/Phi-3.5-mini-instruct". */
  hf_id: string;
  /** Approximate parameter count in billions (informational). */
  approx_params_b?: number;
  /** VRAM reported by `nvidia-smi` after cold load, MiB. */
  vram_mib?: number;
}

export interface BenchOutputCheck {
  /** "Y" / "N" / "skipped". */
  output_match: 'Y' | 'N' | 'skipped';
  /** Numeric delta between canonical and restored output (0 on exact match). */
  output_delta?: number;
  /** Captured before capture/terminate. */
  canonical_output?: string;
  /** Captured after restore. */
  restored_output?: string;
}

export interface BenchErrorEntry {
  phase: string;
  message: string;
  fatal?: boolean;
}

export interface BenchResult {
  schema_version: 1;
  run_id: string;
  started_at_iso: string;
  finished_at_iso?: string;
  gateway_url: string;
  region: string;
  gpu: string;
  provider: 'hyperstack';
  snapshot_key?: string;
  bucket?: string;
  model: BenchModelMeta;
  timings: BenchTimings;
  output_check: BenchOutputCheck;
  errors: BenchErrorEntry[];
  /** Derived summary — filled by finalizeResult. */
  summary?: BenchSummary;
}

export interface BenchSummary {
  cold_total_ms: number | null;
  warm_total_ms: number | null;
  speedup: number | null;
  capture_overhead_ms: number | null;
}

// ── Pure computations ───────────────────────────────────────────────────────

/** cold = full provision from scratch with no snapshot available. */
export function computeColdTotalMs(t: BenchTimings): number | null {
  const parts = [t.vm_b_boot_ms, t.vm_b_tools_install_ms, t.cold_load_ms];
  if (parts.some(v => v === undefined)) return null;
  return parts.reduce<number>((a, v) => a + (v ?? 0), 0);
}

/** warm = provision VM + install tools + pull snapshot + restore. */
export function computeWarmTotalMs(t: BenchTimings): number | null {
  const parts = [
    t.vm_b_boot_ms,
    t.vm_b_tools_install_ms,
    t.download_ms,
    t.decompress_ms,
    t.restore_ms,
    t.toggle_restore_ms,
  ];
  if (parts.some(v => v === undefined)) return null;
  return parts.reduce<number>((a, v) => a + (v ?? 0), 0);
}

/** Pay-once cost of capturing + publishing a snapshot. */
export function computeCaptureOverheadMs(t: BenchTimings): number | null {
  const parts = [t.toggle_drain_ms, t.dump_ms, t.compress_ms, t.upload_ms];
  if (parts.some(v => v === undefined)) return null;
  return parts.reduce<number>((a, v) => a + (v ?? 0), 0);
}

/** speedup = cold_total_ms / warm_total_ms; null if either is missing/zero. */
export function computeSpeedup(input: { cold: number | null; warm: number | null }): number | null {
  const { cold, warm } = input;
  if (cold === null || warm === null) return null;
  if (warm <= 0) return null;
  return cold / warm;
}

/** Fills `summary` on a BenchResult in-place and returns the same object. */
export function finalizeResult(result: BenchResult): BenchResult {
  const cold = computeColdTotalMs(result.timings);
  const warm = computeWarmTotalMs(result.timings);
  result.summary = {
    cold_total_ms: cold,
    warm_total_ms: warm,
    speedup: computeSpeedup({ cold, warm }),
    capture_overhead_ms: computeCaptureOverheadMs(result.timings),
  };
  if (!result.finished_at_iso) result.finished_at_iso = new Date().toISOString();
  return result;
}

// ── Env preflight ──────────────────────────────────────────────────────────

export interface PreflightResult {
  ok: boolean;
  missing: string[];
}

/**
 * Checks the env vars required to run a capture against Hyperstack Object
 * Storage. Pure — takes an env dict, returns a report.
 */
export function preflightEnv(
  env: Record<string, string | undefined>,
  requireCapture: boolean,
): PreflightResult {
  const required = [
    'HYPERSTACK_API_KEY',
    'HYPERSTACK_SNAPSHOTS_BUCKET',
    'HYPERSTACK_SNAPSHOTS_ENDPOINT',
    'HYPERSTACK_SNAPSHOTS_ACCESS_KEY',
    'HYPERSTACK_SNAPSHOTS_SECRET_KEY',
  ];
  // For a pure restore (`--no-capture`) the API key isn't required if the
  // caller only needs to spin VM_B via gateway. But we keep it in the check
  // because `/v1/gpu/deploy` ultimately needs it anyway.
  void requireCapture;
  const missing = required.filter(k => !env[k]);
  return { ok: missing.length === 0, missing };
}

// ── Snapshot key helpers ────────────────────────────────────────────────────

/** Slugify an HF model id for use as an S3 key segment. */
export function modelSlug(hfId: string): string {
  return hfId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Build the bucket key for a capture. Deterministic for a given timestamp. */
export function buildSnapshotKey(model: string, timestampMs: number): string {
  const iso = new Date(timestampMs).toISOString().replace(/[:.]/g, '-');
  return `bench/${modelSlug(model)}/${iso}.tar.zst`;
}

// ── Output comparison ──────────────────────────────────────────────────────

/**
 * Compares a canonical string output captured on VM_A to what came back on
 * VM_B after restore. Handles numeric-looking outputs (e.g. "-12345.678") by
 * computing |delta|; otherwise does exact string compare.
 */
export function compareOutputs(canonical: string, restored: string): BenchOutputCheck {
  if (canonical === restored) {
    return { output_match: 'Y', output_delta: 0, canonical_output: canonical, restored_output: restored };
  }
  const a = Number(canonical.trim());
  const b = Number(restored.trim());
  if (Number.isFinite(a) && Number.isFinite(b)) {
    const delta = Math.abs(a - b);
    return {
      output_match: delta === 0 ? 'Y' : 'N',
      output_delta: delta,
      canonical_output: canonical,
      restored_output: restored,
    };
  }
  return { output_match: 'N', canonical_output: canonical, restored_output: restored };
}

// ── Markdown rendering ─────────────────────────────────────────────────────

function fmtMs(v: number | undefined | null): string {
  if (v === undefined || v === null) return '—';
  if (v < 1000) return `${v.toFixed(0)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function fmtBytes(v: number | undefined): string {
  if (v === undefined) return '—';
  const mb = v / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GiB`;
  return `${mb.toFixed(1)} MiB`;
}

/**
 * Returns a GitHub-Flavoured-Markdown table summarising a finalised result.
 * Pure — caller writes to stdout or a file.
 */
export function formatMarkdownTable(result: BenchResult): string {
  const t = result.timings;
  const s = result.summary ?? {
    cold_total_ms: null,
    warm_total_ms: null,
    speedup: null,
    capture_overhead_ms: null,
  };
  const lines: string[] = [];
  lines.push(`## Cross-VM snapshot bench — ${result.model.hf_id}`);
  lines.push('');
  lines.push(`- run: \`${result.run_id}\``);
  lines.push(`- gpu: ${result.gpu} (${result.region}, ${result.provider})`);
  if (result.snapshot_key) lines.push(`- snapshot: \`${result.snapshot_key}\``);
  lines.push(`- output match: **${result.output_check.output_match}**`);
  if (result.output_check.output_delta !== undefined) {
    lines.push(`- output delta: ${result.output_check.output_delta}`);
  }
  lines.push('');
  lines.push('| phase | duration |');
  lines.push('|-------|----------|');
  lines.push(`| VM_A boot | ${fmtMs(t.vm_a_boot_ms)} |`);
  lines.push(`| VM_A tools install | ${fmtMs(t.vm_a_tools_install_ms)} |`);
  lines.push(`| cold model load | ${fmtMs(t.cold_load_ms)} |`);
  lines.push(`| cuda-checkpoint drain | ${fmtMs(t.toggle_drain_ms)} |`);
  lines.push(`| criu dump | ${fmtMs(t.dump_ms)} |`);
  lines.push(`| compress (zstd) | ${fmtMs(t.compress_ms)} |`);
  lines.push(`| snapshot size | ${fmtBytes(t.compressed_size_bytes)} |`);
  lines.push(`| upload | ${fmtMs(t.upload_ms)} |`);
  lines.push(`| VM_A terminate | ${fmtMs(t.vm_a_terminate_ms)} |`);
  lines.push(`| VM_B boot | ${fmtMs(t.vm_b_boot_ms)} |`);
  lines.push(`| VM_B tools install | ${fmtMs(t.vm_b_tools_install_ms)} |`);
  lines.push(`| download | ${fmtMs(t.download_ms)} |`);
  lines.push(`| decompress | ${fmtMs(t.decompress_ms)} |`);
  lines.push(`| criu restore | ${fmtMs(t.restore_ms)} |`);
  lines.push(`| cuda-checkpoint restore | ${fmtMs(t.toggle_restore_ms)} |`);
  lines.push(`| VM_B terminate | ${fmtMs(t.vm_b_terminate_ms)} |`);
  lines.push('');
  lines.push('| summary | value |');
  lines.push('|---------|-------|');
  lines.push(`| cold_total_ms | ${fmtMs(s.cold_total_ms)} |`);
  lines.push(`| warm_total_ms | ${fmtMs(s.warm_total_ms)} |`);
  lines.push(`| **speedup** | ${s.speedup === null ? '—' : s.speedup.toFixed(2) + 'x'} |`);
  lines.push(`| capture_overhead_ms (pay-once) | ${fmtMs(s.capture_overhead_ms)} |`);
  if (result.errors.length > 0) {
    lines.push('');
    lines.push(`### errors (${result.errors.length})`);
    for (const e of result.errors) {
      lines.push(`- \`${e.phase}\`${e.fatal ? ' (fatal)' : ''}: ${e.message}`);
    }
  }
  return lines.join('\n');
}

/** Compact single-line summary appended to the history JSONL. */
export function buildHistoryLine(result: BenchResult): string {
  const s = result.summary ?? {
    cold_total_ms: null,
    warm_total_ms: null,
    speedup: null,
    capture_overhead_ms: null,
  };
  const rec = {
    ts: result.finished_at_iso ?? new Date().toISOString(),
    run_id: result.run_id,
    model: result.model.hf_id,
    gpu: result.gpu,
    region: result.region,
    provider: result.provider,
    cold_total_ms: s.cold_total_ms,
    warm_total_ms: s.warm_total_ms,
    speedup: s.speedup,
    capture_overhead_ms: s.capture_overhead_ms,
    snapshot_key: result.snapshot_key ?? null,
    compressed_size_bytes: result.timings.compressed_size_bytes ?? null,
    output_match: result.output_check.output_match,
    errors: result.errors.length,
  };
  return JSON.stringify(rec);
}

// ── Shell-argument safety ──────────────────────────────────────────────────

/**
 * Throws if `token` contains anything outside a conservative set used in our
 * SSH command strings (alnum + `-_./:=`). All untrusted inputs are validated
 * with this before being spliced into a single-arg `ssh` command.
 */
export function assertSafeShellToken(token: string, field: string): void {
  if (!/^[A-Za-z0-9_\-./:=@]+$/.test(token)) {
    throw new Error(`unsafe ${field}: ${JSON.stringify(token)}`);
  }
}
