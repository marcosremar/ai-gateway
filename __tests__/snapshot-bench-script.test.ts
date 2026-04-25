import { describe, it, expect } from 'vitest';
import {
  computeColdTotalMs,
  computeWarmTotalMs,
  computeCaptureOverheadMs,
  computeSpeedup,
  finalizeResult,
  formatMarkdownTable,
  buildHistoryLine,
  buildSnapshotKey,
  compareOutputs,
  preflightEnv,
  assertSafeShellToken,
  modelSlug,
  type BenchResult,
} from '../scripts/snapshot-bench/core';

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyResult(): BenchResult {
  return {
    schema_version: 1,
    run_id: 'test-run',
    started_at_iso: '2026-04-18T00:00:00.000Z',
    gateway_url: 'http://localhost:4100',
    region: 'CANADA-1',
    gpu: 'L40',
    provider: 'hyperstack',
    model: { hf_id: 'microsoft/Phi-3.5-mini-instruct' },
    timings: {},
    output_check: { output_match: 'skipped' },
    errors: [],
  };
}

// ── Pure computations ──────────────────────────────────────────────────────

describe('snapshot-bench core — timing math', () => {
  it('computes cold_total_ms as sum of VM_B boot + tools + cold_load', () => {
    expect(computeColdTotalMs({ vm_b_boot_ms: 10, vm_b_tools_install_ms: 20, cold_load_ms: 30 })).toBe(60);
  });

  it('returns null when any cold component is missing', () => {
    expect(computeColdTotalMs({ vm_b_boot_ms: 10, vm_b_tools_install_ms: 20 })).toBeNull();
  });

  it('computes warm_total_ms as sum of all six restore components', () => {
    const t = {
      vm_b_boot_ms: 1000,
      vm_b_tools_install_ms: 2000,
      download_ms: 3000,
      decompress_ms: 500,
      restore_ms: 1500,
      toggle_restore_ms: 200,
    };
    expect(computeWarmTotalMs(t)).toBe(8200);
  });

  it('captures pay-once overhead', () => {
    expect(computeCaptureOverheadMs({
      toggle_drain_ms: 100, dump_ms: 4000, compress_ms: 2000, upload_ms: 8000,
    })).toBe(14100);
  });

  it('computeSpeedup({cold, warm}) divides cold/warm', () => {
    expect(computeSpeedup({ cold: 100_000, warm: 20_000 })).toBe(5);
  });

  it('computeSpeedup returns null if either side is missing', () => {
    expect(computeSpeedup({ cold: null, warm: 20_000 })).toBeNull();
    expect(computeSpeedup({ cold: 100_000, warm: null })).toBeNull();
  });

  it('computeSpeedup returns null on warm=0 (no divide-by-zero)', () => {
    expect(computeSpeedup({ cold: 100_000, warm: 0 })).toBeNull();
  });
});

// ── finalizeResult ─────────────────────────────────────────────────────────

describe('finalizeResult', () => {
  it('fills in the summary block from the timings', () => {
    const r = emptyResult();
    r.timings = {
      vm_b_boot_ms: 1000,
      vm_b_tools_install_ms: 1000,
      cold_load_ms: 8000,
      download_ms: 500,
      decompress_ms: 100,
      restore_ms: 200,
      toggle_restore_ms: 50,
      toggle_drain_ms: 50,
      dump_ms: 1000,
      compress_ms: 500,
      upload_ms: 2000,
    };
    finalizeResult(r);
    expect(r.summary).toBeDefined();
    expect(r.summary!.cold_total_ms).toBe(10_000);
    expect(r.summary!.warm_total_ms).toBe(2850);
    expect(r.summary!.speedup).toBeCloseTo(10_000 / 2850, 5);
    expect(r.summary!.capture_overhead_ms).toBe(3550);
    expect(r.finished_at_iso).toBeDefined();
  });

  it('yields null summary fields when timings are incomplete', () => {
    const r = emptyResult();
    r.timings = { vm_b_boot_ms: 1000 };
    finalizeResult(r);
    expect(r.summary!.cold_total_ms).toBeNull();
    expect(r.summary!.warm_total_ms).toBeNull();
    expect(r.summary!.speedup).toBeNull();
  });
});

// ── Preflight ──────────────────────────────────────────────────────────────

describe('preflightEnv', () => {
  it('fails when HYPERSTACK_API_KEY + SNAPSHOTS_* are missing', () => {
    const r = preflightEnv({}, true);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('HYPERSTACK_API_KEY');
    expect(r.missing).toContain('HYPERSTACK_SNAPSHOTS_BUCKET');
  });

  it('passes when all five required vars are present', () => {
    const env = {
      HYPERSTACK_API_KEY: 'x',
      HYPERSTACK_SNAPSHOTS_BUCKET: 'b',
      HYPERSTACK_SNAPSHOTS_ENDPOINT: 'https://x',
      HYPERSTACK_SNAPSHOTS_ACCESS_KEY: 'ak',
      HYPERSTACK_SNAPSHOTS_SECRET_KEY: 'sk',
    };
    const r = preflightEnv(env, true);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

// ── Snapshot key ───────────────────────────────────────────────────────────

describe('buildSnapshotKey', () => {
  it('slugs the model id and embeds a colon-free ISO timestamp', () => {
    const key = buildSnapshotKey('microsoft/Phi-3.5-mini-instruct', Date.parse('2026-04-18T20:00:00.000Z'));
    expect(key).toBe('bench/microsoft-phi-3-5-mini-instruct/2026-04-18T20-00-00-000Z.tar.zst');
  });

  it('modelSlug lowercases and collapses non-alnum', () => {
    expect(modelSlug('openai/Whisper-Large-V3')).toBe('openai-whisper-large-v3');
  });
});

// ── Output comparison ──────────────────────────────────────────────────────

describe('compareOutputs', () => {
  it('exact string match → Y, delta 0', () => {
    const r = compareOutputs('hello', 'hello');
    expect(r.output_match).toBe('Y');
    expect(r.output_delta).toBe(0);
  });

  it('numeric outputs → delta, match Y iff delta===0', () => {
    expect(compareOutputs('123.5', '123.5').output_match).toBe('Y');
    const r = compareOutputs('123.5', '124');
    expect(r.output_match).toBe('N');
    expect(r.output_delta).toBeCloseTo(0.5, 5);
  });

  it('non-matching strings → N, no delta', () => {
    const r = compareOutputs('hello', 'world');
    expect(r.output_match).toBe('N');
    expect(r.output_delta).toBeUndefined();
  });
});

// ── Markdown / history ─────────────────────────────────────────────────────

describe('formatMarkdownTable', () => {
  it('produces a table containing key numbers and headings', () => {
    const r = emptyResult();
    r.timings = {
      vm_b_boot_ms: 1000, vm_b_tools_install_ms: 1000, cold_load_ms: 8000,
      download_ms: 500, decompress_ms: 100, restore_ms: 200, toggle_restore_ms: 50,
      toggle_drain_ms: 50, dump_ms: 1000, compress_ms: 500, upload_ms: 2000,
      compressed_size_bytes: 1024 * 1024 * 1024,
    };
    r.snapshot_key = 'bench/foo/x.tar.zst';
    r.output_check = { output_match: 'Y', output_delta: 0 };
    finalizeResult(r);
    const md = formatMarkdownTable(r);
    expect(md).toContain('Cross-VM snapshot bench');
    expect(md).toContain(r.model.hf_id);
    expect(md).toContain('VM_A boot');
    expect(md).toContain('criu dump');
    expect(md).toContain('speedup');
    expect(md).toContain('snapshot size');
    // cold/warm should render with units.
    expect(md).toMatch(/cold_total_ms \| \d/);
    expect(md).toMatch(/warm_total_ms \| \d/);
  });

  it('renders em-dash placeholders for missing fields', () => {
    const r = emptyResult();
    finalizeResult(r);
    const md = formatMarkdownTable(r);
    expect(md).toContain('| —');
  });

  it('appends an error section only when errors exist', () => {
    const r = emptyResult();
    finalizeResult(r);
    expect(formatMarkdownTable(r)).not.toContain('### errors');
    r.errors.push({ phase: 'capture', message: 'boom', fatal: true });
    expect(formatMarkdownTable(r)).toContain('### errors (1)');
  });
});

describe('buildHistoryLine', () => {
  it('is valid JSON with a stable shape', () => {
    const r = emptyResult();
    r.timings = {
      vm_b_boot_ms: 1000, vm_b_tools_install_ms: 1000, cold_load_ms: 8000,
      download_ms: 500, decompress_ms: 100, restore_ms: 200, toggle_restore_ms: 50,
      compressed_size_bytes: 42,
    };
    r.snapshot_key = 'bench/foo/x.tar.zst';
    finalizeResult(r);
    const line = buildHistoryLine(r);
    expect(line.endsWith('}')).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.run_id).toBe('test-run');
    expect(parsed.model).toBe('microsoft/Phi-3.5-mini-instruct');
    expect(parsed.gpu).toBe('L40');
    expect(parsed.region).toBe('CANADA-1');
    expect(parsed.provider).toBe('hyperstack');
    expect(parsed.cold_total_ms).toBe(10_000);
    expect(parsed.warm_total_ms).toBe(2850);
    expect(parsed.snapshot_key).toBe('bench/foo/x.tar.zst');
    expect(parsed.compressed_size_bytes).toBe(42);
    expect(parsed.output_match).toBe('skipped');
    expect(parsed.errors).toBe(0);
  });
});

// ── Safety helpers ─────────────────────────────────────────────────────────

describe('assertSafeShellToken', () => {
  it('accepts alnum plus -_./:=@', () => {
    expect(() => assertSafeShellToken('ubuntu@10.0.0.1', 'host')).not.toThrow();
    expect(() => assertSafeShellToken('bench/foo-bar_42/snap.tar.zst', 'key')).not.toThrow();
  });

  it('rejects shell metacharacters', () => {
    expect(() => assertSafeShellToken('foo; rm -rf /', 'key')).toThrow();
    expect(() => assertSafeShellToken('foo$(whoami)', 'key')).toThrow();
    expect(() => assertSafeShellToken('foo bar', 'key')).toThrow();
  });
});
