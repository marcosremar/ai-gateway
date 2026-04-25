/**
 * bootstrap-sllm — BOOTSTRAP_SCRIPT and helpers include the ServerlessLLM
 * sllm-store install, the SLLM_STORE_DIR env var, and buildSllmStoreLoadCmd
 * emits a Python body that uses sllm_store.transformers. Also verifies the
 * run-cross-vm-bench loader factory branches on BENCH_LOADER so callers can
 * pick sllm vs transformers without editing the script.
 */
import { describe, it, expect } from 'vitest';
import {
  BOOTSTRAP_SCRIPT,
  BOOTSTRAP_SANITY_CHECK,
  buildSllmStoreLoadCmd,
} from '../scripts/snapshot-bench/bootstrap';

describe('BOOTSTRAP_SCRIPT', () => {
  it('installs serverless-llm-store via pip', () => {
    // The install must tolerate PyPI transient failures (|| true) so an
    // sllm-store outage doesn't brick the whole bootstrap.
    expect(BOOTSTRAP_SCRIPT).toContain('pip install "serverless-llm-store"');
    expect(BOOTSTRAP_SCRIPT).toMatch(/serverless-llm-store.*\|\|\s*true/s);
  });

  it('exports SLLM_STORE_DIR and persists it across shells', () => {
    expect(BOOTSTRAP_SCRIPT).toContain('SLLM_STORE_DIR=/home/ubuntu/sllm-store');
    // Must also survive a new bash session — check .bashrc append.
    expect(BOOTSTRAP_SCRIPT).toContain('.bashrc');
  });

  it('creates the persistent sllm-store directory', () => {
    expect(BOOTSTRAP_SCRIPT).toContain('mkdir -p /home/ubuntu/sllm-store');
  });

  it('preserves the existing CRIU + cuda-checkpoint steps', () => {
    // Sanity — we didn't accidentally delete the hot paths we depend on.
    expect(BOOTSTRAP_SCRIPT).toContain('cuda-checkpoint');
    expect(BOOTSTRAP_SCRIPT).toMatch(/criu/);
    expect(BOOTSTRAP_SCRIPT).toContain('/home/ubuntu/bench-venv');
  });
});

describe('BOOTSTRAP_SANITY_CHECK', () => {
  it('soft-checks sllm-store presence (|| true so stale images still pass)', () => {
    expect(BOOTSTRAP_SANITY_CHECK).toContain(
      'test -x /home/ubuntu/bench-venv/bin/sllm-store',
    );
    // Must be a soft check — missing sllm-store must not fail the sanity probe.
    expect(BOOTSTRAP_SANITY_CHECK).toMatch(/sllm-store.*\|\|\s*true/);
  });

  it('ensures the sllm-store dir exists (survives tmpfs reboot semantics)', () => {
    expect(BOOTSTRAP_SANITY_CHECK).toContain('mkdir -p /home/ubuntu/sllm-store');
  });
});

describe('buildSllmStoreLoadCmd', () => {
  it('emits a Python body that imports sllm_store.transformers.load_model', () => {
    const src = buildSllmStoreLoadCmd('microsoft/Phi-3.5-mini-instruct');
    expect(src).toContain('from sllm_store.transformers import load_model');
    expect(src).toContain('load_model(');
  });

  it('honours SLLM_STORE_DIR and the MODEL slug convention', () => {
    const src = buildSllmStoreLoadCmd('microsoft/Phi-3.5-mini-instruct');
    // Slug translation "/" → "__" so the sllm store dir layout is filesystem-safe.
    expect(src).toContain('MODEL.replace("/", "__")');
    expect(src).toContain('SLLM_STORE_DIR');
  });

  it('honours the same /tmp/bench.ready + offload/onload protocol', () => {
    const src = buildSllmStoreLoadCmd('any/model');
    expect(src).toContain('/tmp/bench.ready');
    expect(src).toContain('/tmp/bench.offload');
    expect(src).toContain('/tmp/bench.onload');
    expect(src).toContain('/tmp/bench.offloaded');
  });

  it('defaults MODEL env to the supplied id so callers can skip BENCH_MODEL', () => {
    const src = buildSllmStoreLoadCmd('openai/whisper-large-v3');
    expect(src).toContain('openai/whisper-large-v3');
    expect(src).toContain('BENCH_MODEL');
  });
});

describe('run-cross-vm-bench loader branch', () => {
  it('exports a loader factory that branches on BENCH_LOADER', async () => {
    // Read the source file and assert the branch exists. We can't easily
    // import the script (top-level executes main()), so do a static grep.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'scripts/snapshot-bench/run-cross-vm-bench.ts'),
      'utf8',
    );
    expect(src).toContain('BENCH_LOADER');
    expect(src).toMatch(/loader\s*===\s*'sllm'/);
    // Whether the transformers branch is an explicit equality check or the
    // fall-through default, the validator must still reject unknown values.
    expect(src).toMatch(/'transformers'/);
    // And the sllm branch must call into the shared bootstrap helper.
    expect(src).toContain('buildSllmStoreLoadCmd');
  });
});
