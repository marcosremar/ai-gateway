/**
 * gpu-finetune module — unit tests for spec validation, cost estimation,
 * status parsing, compare output parsing, and shell-script composition.
 *
 * No external dependencies; preset loader is exercised against the real
 * `finetune-presets/` tree in this repo (read-only).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateSpec,
  estimateCost,
  lookupGpuSpec,
  parseProbeOutput,
  detectStage,
  buildStatusResult,
  buildProbeCommand,
  parseCompareOutput,
  loadPreset,
  listPresets,
  setPresetsRoot,
  runNumericChecks,
  FinetuneGateway,
  InMemoryFinetuneState,
  FileFinetuneState,
  BUNDLED_PLUGINS,
} from '../src/gpu-finetune';
import type {
  GpuJobRunner,
  FinetuneProbe,
  FinetuneOpts,
  GpuJobResult,
} from '../src/gpu-finetune';

// ─── validateSpec ──────────────────────────────────────────────────────

describe('validateSpec', () => {
  it('accepts well-formed audio spec', () => {
    const r = validateSpec({
      type: 'audio',
      scriptPath: '/tmp/x.py',
      dataset: 'hf://foo/bar',
      epochs: 3,
      lr: 5e-5,
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects bad type when not a preset', () => {
    const r = validateSpec({ type: 'bogus' as 'text', scriptPath: '/tmp/x.py' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('type must be'))).toBe(true);
  });

  it('rejects maxSpend > $100', () => {
    const r = validateSpec({ type: 'audio', scriptPath: '/tmp/x.py', dataset: 'hf://a/b', maxSpend: 999 });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('maxSpend > $100 — refusing as safety guard');
  });

  it('requires hf:// scheme on dataset', () => {
    const r = validateSpec({ type: 'audio', scriptPath: '/tmp/x.py', dataset: 'foo/bar' });
    expect(r.errors).toContain('dataset must use hf://owner/repo form');
  });

  it('rejects out-of-range numeric bounds', () => {
    const r = validateSpec({ type: 'audio', scriptPath: '/tmp/x.py', dataset: 'hf://a/b', epochs: 999, lr: 2 });
    expect(r.errors.some(e => e.startsWith('epochs='))).toBe(true);
    expect(r.errors.some(e => e.startsWith('lr='))).toBe(true);
  });

  it('rejects unknown plugin', () => {
    const r = validateSpec({ type: 'audio', scriptPath: '/tmp/x.py', dataset: 'hf://a/b', plugin: 'nope' });
    expect(r.errors.some(e => e.includes("unknown plugin 'nope'"))).toBe(true);
  });

  it('rejects unknown provider', () => {
    const r = validateSpec({ type: 'audio', scriptPath: '/tmp/x.py', dataset: 'hf://a/b', providers: ['aws'] });
    expect(r.errors.some(e => e.includes('providers contains unknown'))).toBe(true);
  });

  it('rejects smoke + skipSmoke combo', () => {
    const r = validateSpec({ type: 'audio', scriptPath: '/tmp/x.py', dataset: 'hf://a/b', smoke: true, skipSmoke: true });
    expect(r.errors.some(e => e.includes('cannot set both smoke:true and skipSmoke:true'))).toBe(true);
  });
});

// ─── estimateCost ──────────────────────────────────────────────────────

describe('estimateCost', () => {
  it('produces sensible defaults for pocket-tts class', () => {
    const e = estimateCost({ epochs: 4, numGpus: 1 });
    expect(e.encodeMin).toBeGreaterThan(0);
    expect(e.trainMin).toBeGreaterThan(0);
    expect(e.setupMin).toBe(8);
    expect(e.totalMin).toBeCloseTo(e.encodeMin + e.trainMin + e.setupMin, 5);
    expect(e.totalUsd).toBeGreaterThan(0);
  });

  it('honours opts.sampleCount + opts.stepsPerSec overrides', () => {
    const e = estimateCost({ epochs: 1, numGpus: 1, sampleCount: 100, stepsPerSec: 5, encodeRatePerGpu: 50 });
    expect(e.encodeMin).toBeCloseTo(100 / 50 / 60, 5);
  });

  it('honours sampleCount positional override', () => {
    const e = estimateCost({ epochs: 1, numGpus: 1 }, 100);
    expect(e.encodeMin).toBeCloseTo(100 / 25 / 60, 5);
  });

  it('caps at maxSamples when smaller', () => {
    const e1 = estimateCost({ epochs: 1, maxSamples: 50, sampleCount: 1000 });
    const e2 = estimateCost({ epochs: 1, sampleCount: 1000 });
    expect(e1.encodeMin).toBeLessThan(e2.encodeMin);
  });

  // GPU/model/task-aware context (Phase 5) — backward-compatible 4th arg.
  it('a faster GPU lowers train time (and cost) vs the 4090 baseline', () => {
    const opts = { epochs: 2, sampleCount: 1000 };
    const on4090 = estimateCost(opts, 1000, 0.3, { gpuSpec: lookupGpuSpec('4090') });
    const onH100 = estimateCost(opts, 1000, 0.3, { gpuSpec: lookupGpuSpec('H100') });
    expect(onH100.trainMin).toBeLessThan(on4090.trainMin);
  });

  it('encode scales with host CPU cores, not GPU', () => {
    const few = estimateCost({ epochs: 1, sampleCount: 1000 }, 1000, 0.3, { cpuCores: 4 });
    const many = estimateCost({ epochs: 1, sampleCount: 1000 }, 1000, 0.3, { cpuCores: 32 });
    expect(many.encodeMin).toBeLessThan(few.encodeMin);
  });

  it('spot adds expected-eviction overhead to cost (lower reliability = more)', () => {
    const onDemand = estimateCost({ epochs: 2 }, 1000, 0.3, {});
    const spotGood = estimateCost({ epochs: 2 }, 1000, 0.3, { spot: true, reliability: 0.98 });
    const spotBad = estimateCost({ epochs: 2 }, 1000, 0.3, { spot: true, reliability: 0.6 });
    expect(spotGood.totalUsd).toBeGreaterThan(onDemand.totalUsd);
    expect(spotBad.totalUsd).toBeGreaterThan(spotGood.totalUsd);
  });

  it('default call (no ctx) is unchanged', () => {
    const a = estimateCost({ epochs: 4, numGpus: 1 });
    const b = estimateCost({ epochs: 4, numGpus: 1 }, undefined, 0.3, {});
    expect(a.totalUsd).toBeCloseTo(b.totalUsd, 9);
  });
});

// ─── runNumericChecks ───────────────────────────────────────────────────

describe('runNumericChecks', () => {
  it('flags out-of-range values, accepts undefined', () => {
    const r = runNumericChecks({ maxCost: 999, epochs: 5 });
    const byName = Object.fromEntries(r.map(x => [x.name, x]));
    expect(byName['--max-cost / maxCost'].ok).toBe(false);
    expect(byName['--epochs / epochs'].ok).toBe(true);
    expect(byName['--max-spend / maxSpend'].ok).toBe(true); // undefined → ok
  });
});

// ─── parseProbeOutput / detectStage ────────────────────────────────────

const SEP = '__AIGWPROBE__';
function makeProbe(parts: { procs?: string; files?: string; loss?: string; gpu?: string; disk?: string }): string {
  return `${SEP}procs${SEP}\n${parts.procs ?? ''}\n${SEP}files${SEP}\n${parts.files ?? ''}\n${SEP}loss${SEP}\n${parts.loss ?? ''}\n${SEP}gpu${SEP}\n${parts.gpu ?? '0,0,0'}\n${SEP}disk${SEP}\n${parts.disk ?? ''}`;
}

describe('parseProbeOutput', () => {
  it('splits sections by sentinel', () => {
    const p = parseProbeOutput(makeProbe({ procs: 'X', files: '42', loss: 'step=1', gpu: '80,1,2' }));
    expect(p.procs).toBe('X');
    expect(p.files).toBe('42');
    expect(p.loss).toBe('step=1');
    expect(p.gpu).toBe('80,1,2');
  });
});

describe('detectStage', () => {
  it('detects training', () => {
    const p = parseProbeOutput(makeProbe({
      procs: 'root 1 1 1 1 1 1 python finetune.py train --tokens /root/encoded.pt',
      loss: 'step=10/100\nloss=0.5',
    }));
    const s = detectStage(p);
    expect(s.stage).toBe('training');
    expect(s.detail).toContain('step=10/100');
    expect(s.detail).toContain('loss=0.5');
  });

  it('does NOT misclassify train cmd referencing /root/encoded.pt as encoding', () => {
    const p = parseProbeOutput(makeProbe({
      procs: 'root 1 1 1 1 1 1 python finetune.py train --tokens /root/encoded.pt',
    }));
    expect(detectStage(p).stage).toBe('training');
  });

  it('detects encoding (multi-gpu shard script)', () => {
    const p = parseProbeOutput(makeProbe({
      procs: 'root 1 1 1 1 1 1 python encode_multi_gpu.sh',
      loss: 'rate=12.3',
    }));
    const s = detectStage(p);
    expect(s.stage).toBe('encoding');
    expect(s.detail).toBe('rate=12.3');
  });

  it('detects downloading', () => {
    const p = parseProbeOutput(makeProbe({
      procs: 'root 1 1 1 1 1 1 hf download foo/bar',
      files: '500',
    }));
    const s = detectStage(p);
    expect(s.stage).toBe('downloading');
    expect(s.detail).toContain('500 wavs cached');
  });

  it('detects idle (no procs, no ckpts)', () => {
    const p = parseProbeOutput(makeProbe({}));
    expect(detectStage(p).stage).toBe('idle');
  });

  it('detects completed (no procs, ckpt present)', () => {
    const p = parseProbeOutput(makeProbe({ files: 'model.safetensors' }));
    expect(detectStage(p).stage).toBe('completed');
  });

  it('honours custom train pattern', () => {
    const p = parseProbeOutput(makeProbe({
      procs: 'root 1 1 1 1 1 1 python my_trainer.py go',
    }));
    expect(detectStage(p).stage).toBe('?');
    expect(detectStage(p, { train: 'python my_trainer\\.py go' }).stage).toBe('training');
  });
});

// ─── buildProbeCommand ─────────────────────────────────────────────────

describe('buildProbeCommand', () => {
  it('uses defaults', () => {
    const c = buildProbeCommand();
    expect(c).toContain('/root/data/wav');
    expect(c).toContain('/workspace/checkpoints');
    expect(c).toContain('/workspace/.job.log');
  });

  it('honours custom paths', () => {
    const c = buildProbeCommand({ wavDir: '/data/audio', jobLog: '/var/log/job.log' });
    expect(c).toContain('/data/audio');
    expect(c).toContain('/var/log/job.log');
    expect(c).not.toContain('/root/data/wav');
  });
});

// ─── buildStatusResult ─────────────────────────────────────────────────

describe('buildStatusResult', () => {
  it('computes elapsedMin + spent', () => {
    const probe = parseProbeOutput(makeProbe({ gpu: '50,12000,24000' }));
    const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = buildStatusResult(probe, {
      instanceId: 'i-1', gpuType: '4090', provider: 'vast',
      pricePerHr: 0.30, startedAt,
    });
    expect(r.elapsedMin).toBeGreaterThan(29);
    expect(r.elapsedMin).toBeLessThan(31);
    expect(r.spent).toBeCloseTo(0.15, 1);
    expect(r.gpuPct).toBe(50);
    expect(r.vramUsedGb).toBeCloseTo(12000 / 1024, 5);
  });
});

// ─── parseCompareOutput ────────────────────────────────────────────────

describe('parseCompareOutput', () => {
  it('parses winner + result table', () => {
    const out = `loading whisper-base...
ckpt                                         n    avg   plain  tagged
ckpt-A                                       60  0.123  0.100   0.150
ckpt-B                                       60  0.234  0.200   0.270

WINNER: ckpt-A (avg=0.123)`;
    const r = parseCompareOutput(out);
    expect(r.winner).toBe('ckpt-A');
    expect(r.winnerAvgWer).toBeCloseTo(0.123, 5);
    expect(r.results['ckpt-A']).toEqual({ n: 60, avg: 0.123, plain: 0.1, tagged: 0.15 });
    expect(r.results['ckpt-B'].avg).toBeCloseTo(0.234, 5);
  });

  it('returns empty winner if missing', () => {
    expect(parseCompareOutput('garbage').winner).toBe('');
  });
});

// ─── BUNDLED_PLUGINS ───────────────────────────────────────────────────

describe('BUNDLED_PLUGINS', () => {
  it('includes lora, qlora, grad-ckpt, flash-attn', () => {
    expect(BUNDLED_PLUGINS.lora).toBeDefined();
    expect(BUNDLED_PLUGINS.qlora).toBeDefined();
    expect(BUNDLED_PLUGINS['grad-ckpt']).toBeDefined();
    expect(BUNDLED_PLUGINS['flash-attn']).toBeDefined();
  });
});

// ─── loadPreset / listPresets ──────────────────────────────────────────

describe('preset loader', () => {
  it('loads flow-matching-tts from real presets dir', () => {
    setPresetsRoot(null);
    const p = loadPreset('flow-matching-tts');
    expect(p).toBeDefined();
    expect(p?.manifest.name).toBe('flow-matching-tts');
    expect(p?.dir).toMatch(/finetune-presets[\\/]flow-matching-tts$/);
  });

  it('returns undefined for unknown preset', () => {
    setPresetsRoot(null);
    expect(loadPreset('nope')).toBeUndefined();
  });

  it('returns undefined for empty/null type', () => {
    setPresetsRoot(null);
    expect(loadPreset(undefined)).toBeUndefined();
    expect(loadPreset('')).toBeUndefined();
  });

  it('honours setPresetsRoot override', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'finetune-presets-'));
    try {
      mkdirSync(join(tmp, 'demo'));
      writeFileSync(join(tmp, 'demo', 'manifest.json'), JSON.stringify({
        name: 'demo', version: '0.0.1', description: 'd', type: 'text',
        trainerScript: 'trainer.py', trainerInterface: { train: 'x' },
      }));
      setPresetsRoot(tmp);
      const p = loadPreset('demo');
      expect(p?.manifest.name).toBe('demo');
      expect(listPresets().map(x => x.manifest.name)).toContain('demo');
    } finally {
      setPresetsRoot(null);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── FileFinetuneState ─────────────────────────────────────────────────

describe('FileFinetuneState', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'finetune-state-')); });

  it('persists + reloads runs sorted by ts', () => {
    const s = new FileFinetuneState(dir);
    s.save({ id: 'r2', ts: '2026-01-02T00:00:00Z', spec: { type: 'audio' }, instance: {} });
    s.save({ id: 'r1', ts: '2026-01-01T00:00:00Z', spec: { type: 'text' }, instance: {} });
    const all = s.loadAll();
    expect(all.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(s.loadLast()?.id).toBe('r2');
  });

  it('survives across instances', () => {
    new FileFinetuneState(dir).save({ id: 'r1', ts: '2026-01-01T00:00:00Z', spec: {}, instance: {} });
    expect(new FileFinetuneState(dir).loadLast()?.id).toBe('r1');
  });
});

// ─── FinetuneGateway.compose (shell-script composition) ─────────────────

class MockHf { resolve() { return 'fake_token'; } }
class MockRunner implements GpuJobRunner {
  calls: unknown[] = [];
  async run(o: unknown): Promise<GpuJobResult> {
    this.calls.push(o);
    return {
      instanceId: 'i-1', sshHost: 'h', sshPort: 22, gpuType: '4090',
      provider: 'vast', pricePerHr: 0.3, startedAt: new Date().toISOString(),
    };
  }
}
class MockProbe implements FinetuneProbe { async probe() { return ''; } }
const silentLog = { debug() {}, log() {}, warn() {}, error() {} };

function makeGateway() {
  return new FinetuneGateway({
    stateStore: new InMemoryFinetuneState(),
    hfToken: new MockHf(),
    jobRunner: new MockRunner(),
    probe: new MockProbe(),
    log: silentLog,
  });
}

describe('FinetuneGateway.compose', () => {
  beforeEach(() => setPresetsRoot(null));

  it('injects preset defaults (script, deps, model)', () => {
    const gw = makeGateway();
    const { resolved, main } = gw.compose({ type: 'flow-matching-tts', dataset: 'hf://foo/bar' });
    expect(resolved.preset?.manifest.name).toBe('flow-matching-tts');
    expect(resolved.scriptPath).toMatch(/trainer\.py$/);
    expect(resolved.epochs).toBe(2); // preset default
    expect(main).toContain('apt-get update');
    expect(main).toContain('pip install');
    expect(main).toContain('hf download foo/bar');
    expect(main).toContain('cu121'); // pinned torch index
  });

  it('embeds preset smoke verify when smoke=true', () => {
    const gw = makeGateway();
    const { main } = gw.compose({ type: 'flow-matching-tts', dataset: 'hf://foo/bar', smoke: true });
    expect(main).toContain('smoke-verify');
    expect(main).toContain('pocket_tts');
  });

  it('does NOT embed smoke verify when preset has none', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'finetune-presets-'));
    try {
      mkdirSync(join(tmp, 'plain'));
      writeFileSync(join(tmp, 'plain', 'manifest.json'), JSON.stringify({
        name: 'plain', version: '1.0.0', description: 'no smoke', type: 'audio',
        trainerScript: 'trainer.py', trainerInterface: { train: 'x' },
      }));
      writeFileSync(join(tmp, 'plain', 'trainer.py'), '# stub');
      setPresetsRoot(tmp);
      const gw = makeGateway();
      const { main } = gw.compose({ type: 'plain', dataset: 'hf://foo/bar', smoke: true });
      expect(main).not.toContain('smoke-verify');
    } finally {
      setPresetsRoot(null);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('appends plugin lora flags + deps', () => {
    const gw = makeGateway();
    const { main } = gw.compose({ type: 'flow-matching-tts', dataset: 'hf://foo/bar', plugin: 'lora' });
    expect(main).toContain('--use-lora');
    expect(main).toContain('peft');
  });

  it('wires R2 restore/backup + forces resume when r2Bucket + resumeFromR2 + creds present', () => {
    const saved = { ...process.env };
    process.env.B2_ACCOUNT_ID = 'ak_test';
    process.env.B2_APPLICATION_KEY = 'sk_test';
    process.env.B2_ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
    process.env.B2_REGION = 'auto';
    try {
      const gw = makeGateway();
      const { main } = gw.compose({
        type: 'flow-matching-tts', dataset: 'hf://foo/bar',
        r2Bucket: 'tts-ptbr-training', r2Prefix: 'jobs/my-run', resumeFromR2: true,
      });
      // rclone remote env injected
      expect(main).toContain('RCLONE_CONFIG_R2AIGW_ACCESS_KEY_ID');
      expect(main).toContain('RCLONE_CONFIG_R2AIGW_PROVIDER=Cloudflare');
      // restore before train
      expect(main).toContain('rclone copy r2aigw:tts-ptbr-training/jobs/my-run/checkpoints /workspace/checkpoints');
      // resume forced
      expect(main).toContain('--resume /workspace/checkpoints');
      // final backup after push
      expect(main).toContain('rclone sync /workspace/checkpoints r2aigw:tts-ptbr-training/jobs/my-run/checkpoints');
    } finally {
      process.env = saved;
    }
  });

  it('R2 stages no-op (echo skip) when r2Bucket set but creds missing', () => {
    const saved = { ...process.env };
    delete process.env.B2_ACCOUNT_ID; delete process.env.B2_APPLICATION_KEY; delete process.env.B2_ENDPOINT;
    delete process.env.STORAGE_ACCESS_KEY; delete process.env.STORAGE_SECRET_KEY; delete process.env.STORAGE_ENDPOINT;
    try {
      const gw = makeGateway();
      const { main } = gw.compose({
        type: 'flow-matching-tts', dataset: 'hf://foo/bar',
        r2Bucket: 'tts-ptbr-training', resumeFromR2: true,
      });
      expect(main).not.toContain('rclone copy r2aigw:');
      expect(main).toContain('sem creds R2');
    } finally {
      process.env = saved;
    }
  });

  it('omits all R2 stages when r2Bucket unset', () => {
    const gw = makeGateway();
    const { main } = gw.compose({ type: 'flow-matching-tts', dataset: 'hf://foo/bar' });
    expect(main).not.toContain('r2aigw');
    expect(main).not.toContain('RCLONE_CONFIG_R2AIGW');
  });

  it('exportGguf on an audio preset emits a skip notice (not applicable)', () => {
    const gw = makeGateway();
    const { main } = gw.compose({ type: 'flow-matching-tts', dataset: 'hf://foo/bar', exportGguf: true });
    expect(main).toContain('GGUF not applicable');
    expect(main).not.toContain('convert_hf_to_gguf.py');
  });

  it('exportGguf on a text preset wires the GGUF conversion stage', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'finetune-presets-'));
    try {
      mkdirSync(join(tmp, 'txt'));
      writeFileSync(join(tmp, 'txt', 'manifest.json'), JSON.stringify({
        name: 'txt', version: '1.0.0', description: 'text', type: 'text',
        trainerScript: 'trainer.py', trainerInterface: { train: 'x' },
      }));
      writeFileSync(join(tmp, 'txt', 'trainer.py'), '# stub');
      setPresetsRoot(tmp);
      const gw = makeGateway();
      const { main } = gw.compose({ type: 'txt', dataset: 'hf://foo/bar', exportGguf: true });
      expect(main).toContain('convert_hf_to_gguf.py');
      expect(main).toContain('model.gguf');
      expect(main).toContain('non-fatal'); // tolerant of conversion failure
    } finally {
      setPresetsRoot(null);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('omits GGUF stage entirely when exportGguf unset', () => {
    const gw = makeGateway();
    const { main } = gw.compose({ type: 'flow-matching-tts', dataset: 'hf://foo/bar' });
    expect(main).not.toContain('convert_hf_to_gguf.py');
    expect(main).not.toContain('GGUF');
  });

  it('includes notifyOnComplete webhook in non-smoke pipeline', () => {
    const gw = makeGateway();
    const { main } = gw.compose({
      type: 'flow-matching-tts', dataset: 'hf://foo/bar',
      notifyOnComplete: 'https://example.com/hook',
    });
    expect(main).toContain('https://example.com/hook');
    expect(main).toContain('curl -X POST');
  });

  it('omits torch pin when preset lacks one', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'finetune-presets-'));
    try {
      mkdirSync(join(tmp, 'notorch'));
      writeFileSync(join(tmp, 'notorch', 'manifest.json'), JSON.stringify({
        name: 'notorch', version: '1.0.0', description: 'x', type: 'text',
        trainerScript: 'trainer.py', trainerInterface: { train: 'x' },
      }));
      writeFileSync(join(tmp, 'notorch', 'trainer.py'), '# stub');
      setPresetsRoot(tmp);
      const gw = makeGateway();
      const { main } = gw.compose({ type: 'notorch', dataset: 'hf://foo/bar' });
      expect(main).not.toContain('torchaudio==');
    } finally {
      setPresetsRoot(null);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── FinetuneGateway.run (state store wiring) ──────────────────────────

describe('FinetuneGateway.run', () => {
  beforeEach(() => setPresetsRoot(null));

  it('records run in state store + returns runner result', async () => {
    const store = new InMemoryFinetuneState();
    const runner = new MockRunner();
    const gw = new FinetuneGateway({
      stateStore: store,
      hfToken: new MockHf(),
      jobRunner: runner,
      probe: new MockProbe(),
      log: silentLog,
    });
    const result = await gw.run({ type: 'flow-matching-tts', dataset: 'hf://foo/bar' });
    expect(result.instanceId).toBe('i-1');
    expect(runner.calls.length).toBe(1);
    expect(store.loadAll().length).toBe(1);
    expect(store.loadLast()?.spec.type).toBe('flow-matching-tts');
  });
});
