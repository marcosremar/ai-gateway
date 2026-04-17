// ── Parallel Model Downloads (cold-start plan A6) ──────────────────────────
// Source-level contract test for the Python entrypoint that downloads
// Ultravox + Qwen3-TTS. A full integration test would require hitting
// Hugging Face (huge bandwidth, rate-limited); instead we assert that:
//   - the entrypoint uses ThreadPoolExecutor with workers == len(REPOS)
//   - snapshot_download is called once per repo (not a loop that blocks)
//   - hf-xet env vars are preserved (the existing 24% win)
//
// Integration validation plan (manual — documented here):
//   1. `docker build dockers/ultravox-s2s -f Dockerfile -t ultravox-test`
//   2. `docker run --rm ultravox-test python3 /app/download_models.py`
//      - Should print two "[LLM (Ultravox)] ..." and "[TTS (Qwen3-TTS)] ..."
//        log lines interleaved (not sequential).
//      - Total time ≈ max(t_llm, t_tts) + overhead (not t_llm + t_tts).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf-8');

describe('Parallel Model Downloads — cold-start plan A6 (ultravox-s2s)', () => {
  // The dockers submodule is only populated in worktrees where it's
  // explicitly inited. In CI / test environments without the submodule,
  // skip these assertions rather than fail.
  let src: string | null = null;
  try {
    src = read('dockers/ultravox-s2s/download_models.py');
  } catch { src = null; }

  it.skipIf(!src)('uses ThreadPoolExecutor with one worker per repo', () => {
    expect(src!).toContain('from concurrent.futures import ThreadPoolExecutor');
    expect(src!).toMatch(/ThreadPoolExecutor\(max_workers=len\(REPOS\)/);
  });

  it.skipIf(!src)('defines REPOS as a tuple list (LLM + TTS)', () => {
    expect(src!).toMatch(/REPOS\s*=\s*\[/);
    expect(src!).toContain('fixie-ai/ultravox-v0_6-llama-3_1-8b');
    expect(src!).toContain('Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice');
  });

  it.skipIf(!src)('submits each repo via pool.submit (no sequential for-loop with blocking wait)', () => {
    expect(src!).toMatch(/pool\.submit\(_download_one,/);
    expect(src!).toMatch(/as_completed\(futures\)/);
  });

  it.skipIf(!src)('preserves the hf-xet high-performance env vars (existing +24% win)', () => {
    expect(src!).toContain('HF_XET_HIGH_PERFORMANCE');
    expect(src!).toContain('HF_XET_FIXED_DOWNLOAD_CONCURRENCY');
  });

  it.skipIf(!src)('exits with non-zero when any download fails (so Docker build fails loud)', () => {
    // The main() function must return 1 (or equivalent) on error.
    expect(src!).toMatch(/return 1/);
    expect(src!).toMatch(/sys\.exit\(main\(\)\)/);
  });

  it.skipIf(!src)('docs warn against fastsafetensors for encoder-decoder models', () => {
    // Reaffirms the Whisper caveat from our existing memory — A6 must not
    // introduce fastsafetensors (that is Phase B).
    expect(src!).toMatch(/fastsafetensors/);
    expect(src!).toMatch(/encoder-decoder|Phase B/);
  });
});
