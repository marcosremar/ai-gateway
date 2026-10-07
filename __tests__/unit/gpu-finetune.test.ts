// ── gpu-finetune — unit suite ─────────────────────────────────────────────────
// Covers:
//   • validateSpec     — structural, HF refs, numeric bounds, plugins, R2, providers
//   • lintPresetManifest — missing fields, unknown probePaths keys
//   • setPresetsRoot / loadPreset / listPresets — filesystem injection
//   • resolveProjectOpts — unknown project, default merge, type resolution
//   • runNumericChecks — in-range, out-of-range, undefined
//   • lookupGpuSpec   — exact, fuzzy, unknown
//   • gpuVramGb       — known / unknown GPU
//   • relSpeed        — 4090 baseline, relative comparisons
//   • estimateCost    — basic, maxSamples cap, spot markup, multi-GPU
//   • vramNeedGb      — finetune full/lora/qlora, inference, arch-aware
//   • scaleStepsPerSec — GPU speed, param ratio, token ratio, mode factor
//   • detectParamsFromHfConfig — direct count, derived, missing
//   • precisionFromHint — all precision strings, fallback

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateSpec,
  lintPresetManifest,
  setPresetsRoot,
  setProjectsRoot,
  loadPreset,
  listPresets,
  loadProject,
  listProjects,
  resolveProjectOpts,
  runNumericChecks,
} from '../../src/gpu-finetune/spec.js';

import {
  lookupGpuSpec,
  gpuVramGb,
  relSpeed,
  GPU_SPECS,
  BASELINE_GPU,
} from '../../src/gpu-finetune/gpu-specs.js';

import { estimateCost } from '../../src/gpu-finetune/cost.js';

import {
  vramNeedGb,
  scaleStepsPerSec,
  detectParamsFromHfConfig,
  precisionFromHint,
  type WorkloadProfile,
} from '../../src/gpu-finetune/workload.js';

import type { PresetManifest } from '../../src/gpu-finetune/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// type:'audio'/'text' are non-preset types — they require scriptPath just like 'custom'
function minAudio() {
  return { type: 'audio' as const, scriptPath: '/train.py', dataset: 'hf://owner/repo' };
}

function minText() {
  return { type: 'text' as const, scriptPath: '/train.py', dataset: 'hf://owner/data' };
}

function minCustom() {
  return { type: 'custom' as const, scriptPath: '/some/train.py' };
}

function profile(overrides: Partial<WorkloadProfile> = {}): WorkloadProfile {
  return {
    paramsB: 0.1,
    precision: 'bf16',
    task: 'finetune',
    finetuneMode: 'full',
    optimizer: 'adamw',
    gradCkpt: false,
    seqLen: 512,
    batchSize: 2,
    ...overrides,
  };
}

// ─── validateSpec ─────────────────────────────────────────────────────────────

describe('validateSpec', () => {
  describe('structural', () => {
    it('rejects empty spec', () => {
      const r = validateSpec({});
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('missing required'))).toBe(true);
    });

    it('accepts custom type with scriptPath', () => {
      const r = validateSpec(minCustom());
      expect(r.valid).toBe(true);
    });

    it('accepts audio type with scriptPath + hf dataset', () => {
      const r = validateSpec(minAudio());
      expect(r.valid).toBe(true);
    });

    it('accepts text type with scriptPath + hf dataset', () => {
      const r = validateSpec(minText());
      expect(r.valid).toBe(true);
    });

    it('rejects audio type without scriptPath (no preset named audio)', () => {
      const r = validateSpec({ type: 'audio' as const, dataset: 'hf://owner/repo' });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('script'))).toBe(true);
    });

    it('rejects smoke + skipSmoke both true', () => {
      const r = validateSpec({ ...minAudio(), smoke: true, skipSmoke: true });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('smoke'))).toBe(true);
    });

    it('rejects unknown type string', () => {
      const r = validateSpec({ type: 'video' as any, dataset: 'hf://a/b' });
      expect(r.valid).toBe(false);
    });

    it('rejects unknown project', () => {
      const r = validateSpec({ project: 'nonexistent-project-xyz' });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('unknown project'))).toBe(true);
    });
  });

  describe('HF refs', () => {
    it('rejects dataset without hf:// prefix', () => {
      const r = validateSpec({ type: 'audio', dataset: 'owner/repo' });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('hf://'))).toBe(true);
    });

    it('rejects model without hf:// prefix', () => {
      const r = validateSpec({ ...minAudio(), model: 'meta/llama' });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('hf://'))).toBe(true);
    });

    it('accepts model with hf:// prefix', () => {
      const r = validateSpec({ ...minAudio(), model: 'hf://meta/llama' });
      expect(r.valid).toBe(true);
    });

    it('rejects pushToHf without slash', () => {
      const r = validateSpec({ ...minCustom(), pushToHf: 'myrepo' });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('pushToHf'))).toBe(true);
    });

    it('accepts pushToHf with slash', () => {
      const r = validateSpec({ ...minCustom(), pushToHf: 'owner/repo' });
      expect(r.valid).toBe(true);
    });

    it('rejects hfBase without slash', () => {
      const r = validateSpec({ ...minCustom(), hfBase: 'noowner' });
      expect(r.valid).toBe(false);
    });

    it('rejects fromHf without slash', () => {
      const r = validateSpec({ ...minCustom(), fromHf: 'noowner' });
      expect(r.valid).toBe(false);
    });

    it('rejects invalid hfStructure', () => {
      const r = validateSpec({ ...minCustom(), hfStructure: 'invalid' as any });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('hfStructure'))).toBe(true);
    });

    it('accepts flat hfStructure', () => {
      const r = validateSpec({ ...minCustom(), hfStructure: 'flat' });
      expect(r.valid).toBe(true);
    });

    it('accepts split hfStructure', () => {
      const r = validateSpec({ ...minCustom(), hfStructure: 'split' });
      expect(r.valid).toBe(true);
    });

    it('accepts tri hfStructure', () => {
      const r = validateSpec({ ...minCustom(), hfStructure: 'tri' });
      expect(r.valid).toBe(true);
    });

    it('requires dataset for audio type', () => {
      const r = validateSpec({ type: 'audio' });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('dataset'))).toBe(true);
    });
  });

  describe('quality + curriculum + plugin', () => {
    it('rejects invalid quality value', () => {
      const r = validateSpec({ ...minAudio(), quality: 'turbo' as any });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('quality'))).toBe(true);
    });

    it('accepts quality:auto', () => {
      const r = validateSpec({ ...minAudio(), quality: 'auto' });
      expect(r.valid).toBe(true);
    });

    it('accepts quality:safe', () => {
      const r = validateSpec({ ...minAudio(), quality: 'safe' });
      expect(r.valid).toBe(true);
    });

    it('accepts quality:fast', () => {
      const r = validateSpec({ ...minAudio(), quality: 'fast' });
      expect(r.valid).toBe(true);
    });

    it('rejects invalid curriculum', () => {
      const r = validateSpec({ ...minCustom(), curriculum: 'cosine' as any });
      expect(r.valid).toBe(false);
    });

    it('accepts empty curriculum', () => {
      const r = validateSpec({ ...minCustom(), curriculum: '' });
      expect(r.valid).toBe(true);
    });

    it('accepts linear curriculum', () => {
      const r = validateSpec({ ...minCustom(), curriculum: 'linear' });
      expect(r.valid).toBe(true);
    });

    it('rejects unknown plugin', () => {
      const r = validateSpec({ ...minCustom(), plugin: 'unknown-plugin' });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('plugin'))).toBe(true);
    });

    it('accepts known plugin lora', () => {
      const r = validateSpec({ ...minCustom(), plugin: 'lora' });
      expect(r.valid).toBe(true);
    });

    it('accepts known plugin qlora', () => {
      const r = validateSpec({ ...minCustom(), plugin: 'qlora' });
      expect(r.valid).toBe(true);
    });

    it('accepts known plugin flash-attn', () => {
      const r = validateSpec({ ...minCustom(), plugin: 'flash-attn' });
      expect(r.valid).toBe(true);
    });
  });

  describe('R2 / S3', () => {
    it('rejects invalid r2Bucket name (uppercase)', () => {
      const r = validateSpec({ ...minCustom(), r2Bucket: 'My-Bucket' });
      expect(r.valid).toBe(false);
    });

    it('accepts valid r2Bucket name', () => {
      const r = validateSpec({ ...minCustom(), r2Bucket: 'my-bucket-123' });
      expect(r.valid).toBe(true);
    });

    it('rejects r2Prefix with leading slash', () => {
      const r = validateSpec({ ...minCustom(), r2Prefix: '/jobs/run1' });
      expect(r.valid).toBe(false);
    });

    it('accepts r2Prefix without leading slash', () => {
      const r = validateSpec({ ...minCustom(), r2Prefix: 'jobs/run1' });
      expect(r.valid).toBe(true);
    });

    it('rejects resumeFromR2 without r2Bucket', () => {
      const r = validateSpec({ ...minCustom(), resumeFromR2: true });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('resumeFromR2'))).toBe(true);
    });

    it('accepts resumeFromR2 with r2Bucket', () => {
      const r = validateSpec({ ...minCustom(), resumeFromR2: true, r2Bucket: 'my-bucket' });
      expect(r.valid).toBe(true);
    });
  });

  describe('providers', () => {
    it('rejects providers that is not an array', () => {
      const r = validateSpec({ ...minCustom(), providers: 'vast' as any });
      expect(r.valid).toBe(false);
    });

    it('rejects unknown provider names', () => {
      const r = validateSpec({ ...minCustom(), providers: ['aws'] as any });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('unknown'))).toBe(true);
    });

    it('accepts known providers', () => {
      const r = validateSpec({ ...minCustom(), providers: ['vast', 'runpod'] });
      expect(r.valid).toBe(true);
    });

    it('accepts all known providers', () => {
      const r = validateSpec({ ...minCustom(), providers: ['vast', 'runpod', 'tensordock', 'modal', 'hyperstack'] });
      expect(r.valid).toBe(true);
    });
  });

  describe('numeric bounds', () => {
    it('rejects maxCost below minimum', () => {
      const r = validateSpec({ ...minCustom(), maxCost: 0 });
      expect(r.valid).toBe(false);
    });

    it('rejects maxCost above maximum', () => {
      const r = validateSpec({ ...minCustom(), maxCost: 51 });
      expect(r.valid).toBe(false);
    });

    it('accepts maxCost in range', () => {
      const r = validateSpec({ ...minCustom(), maxCost: 5 });
      expect(r.valid).toBe(true);
    });

    it('rejects maxSpend > 100', () => {
      const r = validateSpec({ ...minCustom(), maxSpend: 101 });
      expect(r.valid).toBe(false);
    });

    it('rejects epochs below minimum', () => {
      const r = validateSpec({ ...minCustom(), epochs: 0 });
      expect(r.valid).toBe(false);
    });

    it('rejects epochs above maximum', () => {
      const r = validateSpec({ ...minCustom(), epochs: 101 });
      expect(r.valid).toBe(false);
    });

    it('accepts epochs in range', () => {
      const r = validateSpec({ ...minCustom(), epochs: 5 });
      expect(r.valid).toBe(true);
    });

    it('rejects lr below minimum', () => {
      const r = validateSpec({ ...minCustom(), lr: 0 });
      expect(r.valid).toBe(false);
    });

    it('rejects numGpus above maximum', () => {
      const r = validateSpec({ ...minCustom(), numGpus: 9 });
      expect(r.valid).toBe(false);
    });

    it('accepts numGpus in range', () => {
      const r = validateSpec({ ...minCustom(), numGpus: 4 });
      expect(r.valid).toBe(true);
    });

    it('rejects batchSize below minimum', () => {
      const r = validateSpec({ ...minCustom(), batchSize: 0 });
      expect(r.valid).toBe(false);
    });

    it('rejects gradAccum above maximum', () => {
      const r = validateSpec({ ...minCustom(), gradAccum: 257 });
      expect(r.valid).toBe(false);
    });

    it('rejects gradClip above maximum', () => {
      const r = validateSpec({ ...minCustom(), gradClip: 101 });
      expect(r.valid).toBe(false);
    });
  });
});

// ─── lintPresetManifest ───────────────────────────────────────────────────────

describe('lintPresetManifest', () => {
  const baseManifest: PresetManifest = {
    name: 'test',
    version: '1.0.0',
    description: 'Test preset',
    type: 'audio',
    trainerScript: 'train.py',
    trainerInterface: { train: 'python train.py' },
  };

  it('returns empty array for valid manifest', () => {
    expect(lintPresetManifest(baseManifest)).toEqual([]);
  });

  it('warns on missing trainerScript', () => {
    const m = { ...baseManifest, trainerScript: undefined as any };
    const warns = lintPresetManifest(m);
    expect(warns.some(w => w.includes('trainerScript'))).toBe(true);
  });

  it('warns on missing trainerInterface.train', () => {
    const m = { ...baseManifest, trainerInterface: { train: undefined as any } };
    const warns = lintPresetManifest(m);
    expect(warns.some(w => w.includes('trainerInterface.train'))).toBe(true);
  });

  it('warns on unknown probePaths key', () => {
    const m = { ...baseManifest, probePaths: { unknownKey: '/path' } as any };
    const warns = lintPresetManifest(m);
    expect(warns.some(w => w.includes("unknown probePaths key 'unknownKey'"))).toBe(true);
  });

  it('does not warn on valid probePaths keys', () => {
    const m = { ...baseManifest, probePaths: { wavDir: '/wav', checkpointsDir: '/ckpt' } };
    const warns = lintPresetManifest(m);
    expect(warns).toEqual([]);
  });

  it('accumulates multiple warnings', () => {
    const m = {
      ...baseManifest,
      trainerScript: undefined as any,
      probePaths: { badKey: '/path' } as any,
    };
    const warns = lintPresetManifest(m);
    expect(warns.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Preset filesystem injection ──────────────────────────────────────────────

describe('setPresetsRoot / loadPreset / listPresets', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `aigw-test-presets-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    setPresetsRoot(tmpDir);
  });

  afterEach(() => {
    setPresetsRoot(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined for unknown preset', () => {
    expect(loadPreset('unknown')).toBeUndefined();
  });

  it('returns undefined for null/empty input', () => {
    expect(loadPreset(null)).toBeUndefined();
    expect(loadPreset('')).toBeUndefined();
    expect(loadPreset(undefined)).toBeUndefined();
  });

  it('returns empty list when no presets exist', () => {
    expect(listPresets()).toEqual([]);
  });

  it('loads a valid preset manifest', () => {
    const presetDir = join(tmpDir, 'my-preset');
    mkdirSync(presetDir);
    writeFileSync(join(presetDir, 'manifest.json'), JSON.stringify({
      name: 'my-preset',
      version: '1.0',
      description: 'Test',
      type: 'audio',
      trainerScript: 'train.py',
      trainerInterface: { train: 'python train.py' },
    }));
    const preset = loadPreset('my-preset');
    expect(preset).toBeDefined();
    expect(preset?.manifest.name).toBe('my-preset');
    expect(preset?.dir).toBe(presetDir);
  });

  it('skips malformed manifest JSON', () => {
    const presetDir = join(tmpDir, 'bad-preset');
    mkdirSync(presetDir);
    writeFileSync(join(presetDir, 'manifest.json'), 'not valid json {{{');
    expect(loadPreset('bad-preset')).toBeUndefined();
    expect(listPresets()).toEqual([]);
  });

  it('lists all valid presets', () => {
    for (const name of ['preset-a', 'preset-b']) {
      const d = join(tmpDir, name);
      mkdirSync(d);
      writeFileSync(join(d, 'manifest.json'), JSON.stringify({
        name, version: '1', description: '', type: 'text',
        trainerScript: 'train.py', trainerInterface: { train: 'python train.py' },
      }));
    }
    const list = listPresets();
    expect(list).toHaveLength(2);
    expect(list.map(p => p.manifest.name).sort()).toEqual(['preset-a', 'preset-b']);
  });

  it('skips non-directory entries', () => {
    writeFileSync(join(tmpDir, 'a-file.txt'), 'not a dir');
    expect(listPresets()).toEqual([]);
  });

  it('skips dirs without manifest.json', () => {
    mkdirSync(join(tmpDir, 'no-manifest'));
    expect(listPresets()).toEqual([]);
  });
});

// ─── Project filesystem injection ─────────────────────────────────────────────

describe('setProjectsRoot / loadProject / resolveProjectOpts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `aigw-test-projects-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    setProjectsRoot(tmpDir);
  });

  afterEach(() => {
    setProjectsRoot(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined for unknown project', () => {
    expect(loadProject('nonexistent')).toBeUndefined();
  });

  it('returns undefined for null/empty input', () => {
    expect(loadProject(null)).toBeUndefined();
    expect(loadProject('')).toBeUndefined();
  });

  it('returns empty list when no projects exist', () => {
    expect(listProjects()).toEqual([]);
  });

  it('loads a valid project', () => {
    const pDir = join(tmpDir, 'my-project');
    mkdirSync(pDir);
    writeFileSync(join(pDir, 'project.json'), JSON.stringify({
      name: 'my-project',
      description: 'Test project',
      preset: 'flow-matching-tts',
      defaultDataset: 'hf://me/data',
      defaultEpochs: 10,
    }));
    const p = loadProject('my-project');
    expect(p).toBeDefined();
    expect(p?.manifest.name).toBe('my-project');
    expect(p?.manifest.defaultDataset).toBe('hf://me/data');
  });

  it('resolveProjectOpts merges defaults when project found', () => {
    const pDir = join(tmpDir, 'tts-proj');
    mkdirSync(pDir);
    writeFileSync(join(pDir, 'project.json'), JSON.stringify({
      name: 'tts-proj',
      description: '',
      preset: 'audio',
      defaultDataset: 'hf://me/tts-data',
      defaultEpochs: 8,
      defaultLR: 0.001,
    }));
    const { opts, project } = resolveProjectOpts({ project: 'tts-proj' });
    expect(project).toBeDefined();
    expect(opts.dataset).toBe('hf://me/tts-data');
    expect(opts.epochs).toBe(8);
    expect(opts.lr).toBe(0.001);
  });

  it('resolveProjectOpts caller values take precedence over defaults', () => {
    const pDir = join(tmpDir, 'tts-proj2');
    mkdirSync(pDir);
    writeFileSync(join(pDir, 'project.json'), JSON.stringify({
      name: 'tts-proj2',
      description: '',
      preset: 'audio',
      defaultDataset: 'hf://me/default-data',
      defaultEpochs: 8,
    }));
    const { opts } = resolveProjectOpts({ project: 'tts-proj2', epochs: 20 });
    expect(opts.epochs).toBe(20);
  });

  it('resolveProjectOpts returns unknown project gracefully', () => {
    const { opts, project, preset } = resolveProjectOpts({ project: 'unknown-xyz' });
    expect(project).toBeUndefined();
    expect(preset).toBeUndefined();
    expect(opts.project).toBe('unknown-xyz');
  });
});

// ─── runNumericChecks ─────────────────────────────────────────────────────────

describe('runNumericChecks', () => {
  it('returns all ok when values are undefined', () => {
    const checks = runNumericChecks({});
    expect(checks.every(c => c.ok)).toBe(true);
  });

  it('returns ok for in-range epochs', () => {
    const checks = runNumericChecks({ epochs: 5 });
    const epochCheck = checks.find(c => c.name.includes('epochs'));
    expect(epochCheck?.ok).toBe(true);
  });

  it('returns not-ok for epochs above max', () => {
    const checks = runNumericChecks({ epochs: 200 });
    const epochCheck = checks.find(c => c.name.includes('epochs'));
    expect(epochCheck?.ok).toBe(false);
  });

  it('returns ok for in-range lr', () => {
    const checks = runNumericChecks({ lr: 1e-4 });
    const lrCheck = checks.find(c => c.name.includes('lr'));
    expect(lrCheck?.ok).toBe(true);
  });

  it('returns not-ok for lr below minimum', () => {
    const checks = runNumericChecks({ lr: 0 });
    const lrCheck = checks.find(c => c.name.includes('lr'));
    expect(lrCheck?.ok).toBe(false);
  });

  it('returns not-ok for numGpus = 0', () => {
    const checks = runNumericChecks({ numGpus: 0 });
    const g = checks.find(c => c.name.includes('numGpus'));
    expect(g?.ok).toBe(false);
  });

  it('returns ok for maxCost in range', () => {
    const checks = runNumericChecks({ maxCost: 10 });
    const c = checks.find(c => c.name.includes('maxCost'));
    expect(c?.ok).toBe(true);
  });

  it('returns not-ok for maxSpend above limit', () => {
    const checks = runNumericChecks({ maxSpend: 150 });
    const c = checks.find(c => c.name.includes('maxSpend'));
    expect(c?.ok).toBe(false);
  });
});

// ─── lookupGpuSpec ────────────────────────────────────────────────────────────

describe('lookupGpuSpec', () => {
  it('returns undefined for undefined input', () => {
    expect(lookupGpuSpec(undefined)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(lookupGpuSpec(null)).toBeUndefined();
  });

  it('returns undefined for unknown GPU', () => {
    expect(lookupGpuSpec('NVIDIA GeForce RTX 9999')).toBeUndefined();
  });

  it('exact match returns spec', () => {
    const spec = lookupGpuSpec('NVIDIA GeForce RTX 4090');
    expect(spec).toBeDefined();
    expect(spec?.vramGb).toBe(24);
  });

  it('fuzzy match by model number "4090"', () => {
    const spec = lookupGpuSpec('4090');
    expect(spec).toBeDefined();
    expect(spec?.name).toBe('NVIDIA GeForce RTX 4090');
  });

  it('fuzzy match case-insensitive "rtx 4090"', () => {
    const spec = lookupGpuSpec('rtx 4090');
    expect(spec).toBeDefined();
    expect(spec?.vramGb).toBe(24);
  });

  it('matches A100 80GB PCIe', () => {
    const spec = lookupGpuSpec('NVIDIA A100 80GB PCIe');
    expect(spec).toBeDefined();
    expect(spec?.vramGb).toBe(80);
  });

  it('fuzzy match "a100"', () => {
    const spec = lookupGpuSpec('a100');
    expect(spec).toBeDefined();
  });

  it('matches H100', () => {
    const spec = lookupGpuSpec('NVIDIA H100 80GB HBM3');
    expect(spec?.bf16Tflops).toBeGreaterThan(GPU_SPECS[BASELINE_GPU].bf16Tflops);
  });

  it('matches L40S', () => {
    const spec = lookupGpuSpec('l40s');
    expect(spec).toBeDefined();
    expect(spec?.vramGb).toBe(48);
  });

  it('RTX 5090 is Blackwell with 32GB VRAM', () => {
    const spec = lookupGpuSpec('NVIDIA GeForce RTX 5090');
    expect(spec?.vramGb).toBe(32);
  });
});

// ─── gpuVramGb ────────────────────────────────────────────────────────────────

describe('gpuVramGb', () => {
  it('returns 24 for RTX 4090', () => {
    expect(gpuVramGb('NVIDIA GeForce RTX 4090')).toBe(24);
  });

  it('returns 80 for A100 80GB', () => {
    expect(gpuVramGb('NVIDIA A100 80GB PCIe')).toBe(80);
  });

  it('returns 48 for A6000', () => {
    expect(gpuVramGb('NVIDIA RTX A6000')).toBe(48);
  });

  it('returns undefined for unknown GPU', () => {
    expect(gpuVramGb('NVIDIA GeForce RTX 9999')).toBeUndefined();
  });

  it('returns undefined for null/undefined', () => {
    expect(gpuVramGb(null)).toBeUndefined();
    expect(gpuVramGb(undefined)).toBeUndefined();
  });
});

// ─── relSpeed ─────────────────────────────────────────────────────────────────

describe('relSpeed', () => {
  it('returns 1.0 for undefined spec', () => {
    expect(relSpeed(undefined)).toBe(1);
  });

  it('returns 1.0 for RTX 4090 (baseline)', () => {
    const spec = lookupGpuSpec(BASELINE_GPU)!;
    expect(relSpeed(spec)).toBeCloseTo(1.0, 5);
  });

  it('H100 is faster than 4090', () => {
    const h100 = lookupGpuSpec('NVIDIA H100 80GB HBM3')!;
    const baseline = lookupGpuSpec(BASELINE_GPU)!;
    expect(relSpeed(h100)).toBeGreaterThan(relSpeed(baseline));
  });

  it('V100 is slower than 4090', () => {
    const v100 = lookupGpuSpec('NVIDIA V100')!;
    expect(relSpeed(v100)).toBeLessThan(1.0);
  });

  it('RTX 5090 is faster than 4090', () => {
    const r5090 = lookupGpuSpec('NVIDIA GeForce RTX 5090')!;
    expect(relSpeed(r5090)).toBeGreaterThan(1.0);
  });

  it('RTX 3090 is slower than 4090', () => {
    const r3090 = lookupGpuSpec('NVIDIA GeForce RTX 3090')!;
    expect(relSpeed(r3090)).toBeLessThan(1.0);
  });
});

// ─── estimateCost ─────────────────────────────────────────────────────────────

describe('estimateCost', () => {
  it('returns non-zero totals for minimal spec', () => {
    const est = estimateCost({ type: 'audio' });
    expect(est.totalMin).toBeGreaterThan(0);
    expect(est.totalUsd).toBeGreaterThan(0);
    expect(est.setupMin).toBe(8);
  });

  it('totalMin = encodeMin + trainMin + setupMin', () => {
    const est = estimateCost({ type: 'audio' });
    expect(est.totalMin).toBeCloseTo(est.encodeMin + est.trainMin + est.setupMin, 5);
  });

  it('maxSamples cap reduces estimate vs full dataset', () => {
    const full = estimateCost({ type: 'audio' }, 10000);
    const capped = estimateCost({ type: 'audio', maxSamples: 100 }, 10000);
    expect(capped.trainMin).toBeLessThan(full.trainMin);
    expect(capped.encodeMin).toBeLessThan(full.encodeMin);
  });

  it('more epochs increases train time', () => {
    const few = estimateCost({ type: 'audio', epochs: 1 });
    const many = estimateCost({ type: 'audio', epochs: 10 });
    expect(many.trainMin).toBeGreaterThan(few.trainMin);
  });

  it('more GPUs reduces encode time', () => {
    const one = estimateCost({ type: 'audio', numGpus: 1 });
    const four = estimateCost({ type: 'audio', numGpus: 4 });
    expect(four.encodeMin).toBeLessThan(one.encodeMin);
  });

  it('higher gpuPrice increases cost', () => {
    const cheap = estimateCost({ type: 'audio' }, undefined, 0.30);
    const expensive = estimateCost({ type: 'audio' }, undefined, 3.00);
    expect(expensive.totalUsd).toBeGreaterThan(cheap.totalUsd);
  });

  it('spot pricing adds overhead', () => {
    const onDemand = estimateCost({ type: 'audio' }, undefined, 0.30, { spot: false });
    const spot = estimateCost({ type: 'audio' }, undefined, 0.30, { spot: true, reliability: 0.7 });
    expect(spot.totalUsd).toBeGreaterThan(onDemand.totalUsd);
  });

  it('faster GPU reduces train time', () => {
    const h100Spec = lookupGpuSpec('NVIDIA H100 80GB HBM3')!;
    const baseSpec = lookupGpuSpec(BASELINE_GPU)!;
    const slow = estimateCost({ type: 'audio' }, undefined, 0.30, { gpuSpec: baseSpec });
    const fast = estimateCost({ type: 'audio' }, undefined, 0.30, { gpuSpec: h100Spec });
    expect(fast.trainMin).toBeLessThan(slow.trainMin);
  });

  it('explicit sampleCount overrides default', () => {
    const small = estimateCost({ type: 'audio' }, 100);
    const large = estimateCost({ type: 'audio' }, 100000);
    expect(large.totalMin).toBeGreaterThan(small.totalMin);
  });

  it('more CPU cores reduces encode time', () => {
    const few = estimateCost({ type: 'audio' }, undefined, 0.30, { cpuCores: 2 });
    const many = estimateCost({ type: 'audio' }, undefined, 0.30, { cpuCores: 32 });
    expect(many.encodeMin).toBeLessThan(few.encodeMin);
  });
});

// ─── vramNeedGb ──────────────────────────────────────────────────────────────

describe('vramNeedGb', () => {
  it('returns positive VRAM for small finetune', () => {
    const { gb } = vramNeedGb(profile({ paramsB: 0.1 }));
    expect(gb).toBeGreaterThan(0);
  });

  it('full finetune needs more VRAM than LoRA', () => {
    const full = vramNeedGb(profile({ finetuneMode: 'full' })).gb;
    const lora = vramNeedGb(profile({ finetuneMode: 'lora' })).gb;
    expect(full).toBeGreaterThan(lora);
  });

  it('LoRA needs more VRAM than QLoRA (QLoRA uses int4 base weights)', () => {
    // QLoRA quantizes base weights to 4-bit → significantly less weightsGb
    const lora = vramNeedGb(profile({ finetuneMode: 'lora', precision: 'bf16', paramsB: 7 })).gb;
    const qlora = vramNeedGb(profile({ finetuneMode: 'qlora', precision: 'int4', paramsB: 7 })).gb;
    expect(lora).toBeGreaterThan(qlora);
  });

  it('larger model needs more VRAM', () => {
    const small = vramNeedGb(profile({ paramsB: 0.1 })).gb;
    const large = vramNeedGb(profile({ paramsB: 70 })).gb;
    expect(large).toBeGreaterThan(small);
  });

  it('gradient checkpointing reduces VRAM', () => {
    const noGc = vramNeedGb(profile({ gradCkpt: false, paramsB: 7 })).gb;
    const gc = vramNeedGb(profile({ gradCkpt: true, paramsB: 7 })).gb;
    expect(gc).toBeLessThan(noGc);
  });

  it('inference returns KV cache, not optimizer states', () => {
    const { breakdown } = vramNeedGb(profile({ task: 'inference', finetuneMode: 'full' }));
    expect(breakdown.statesGb).toBe(0);
    expect(breakdown.kvGb).toBeGreaterThan(0);
  });

  it('includes breakdown fields', () => {
    const { breakdown } = vramNeedGb(profile());
    expect(breakdown).toHaveProperty('weightsGb');
    expect(breakdown).toHaveProperty('statesGb');
    expect(breakdown).toHaveProperty('activationsGb');
    expect(breakdown).toHaveProperty('kvGb');
    expect(breakdown).toHaveProperty('overheadGb');
  });

  it('arch-aware path uses hidden+layers', () => {
    const archAware = vramNeedGb(profile({ hiddenSize: 4096, numLayers: 32 })).gb;
    const generic = vramNeedGb(profile()).gb;
    // Just verify both paths return a positive number
    expect(archAware).toBeGreaterThan(0);
    expect(generic).toBeGreaterThan(0);
  });
});

// ─── scaleStepsPerSec ─────────────────────────────────────────────────────────

describe('scaleStepsPerSec', () => {
  const baseline = { stepsPerSec: 3, paramsB: 0.1, tokensPerStep: 1024 };

  it('returns positive value', () => {
    const result = scaleStepsPerSec(baseline, profile(), undefined);
    expect(result).toBeGreaterThan(0);
  });

  it('faster GPU increases throughput', () => {
    const h100 = lookupGpuSpec('NVIDIA H100 80GB HBM3')!;
    const r4090 = lookupGpuSpec(BASELINE_GPU)!;
    const slow = scaleStepsPerSec(baseline, profile(), r4090);
    const fast = scaleStepsPerSec(baseline, profile(), h100);
    expect(fast).toBeGreaterThan(slow);
  });

  it('larger model decreases throughput', () => {
    const small = scaleStepsPerSec(baseline, profile({ paramsB: 0.1 }), undefined);
    const large = scaleStepsPerSec(baseline, profile({ paramsB: 7 }), undefined);
    expect(large).toBeLessThan(small);
  });

  it('longer sequence decreases throughput', () => {
    const short = scaleStepsPerSec(baseline, profile({ seqLen: 128 }), undefined);
    const long = scaleStepsPerSec(baseline, profile({ seqLen: 4096 }), undefined);
    expect(long).toBeLessThan(short);
  });

  it('LoRA is faster than full finetune', () => {
    const full = scaleStepsPerSec(baseline, profile({ finetuneMode: 'full' }), undefined);
    const lora = scaleStepsPerSec(baseline, profile({ finetuneMode: 'lora' }), undefined);
    expect(lora).toBeGreaterThan(full);
  });

  it('QLoRA is slower than LoRA', () => {
    const lora = scaleStepsPerSec(baseline, profile({ finetuneMode: 'lora' }), undefined);
    const qlora = scaleStepsPerSec(baseline, profile({ finetuneMode: 'qlora' }), undefined);
    expect(qlora).toBeLessThan(lora);
  });

  it('inference is faster than finetune', () => {
    const finetune = scaleStepsPerSec(baseline, profile({ task: 'finetune' }), undefined);
    const inference = scaleStepsPerSec(baseline, profile({ task: 'inference' }), undefined);
    expect(inference).toBeGreaterThan(finetune);
  });

  it('clamps to minimum 0.01 for extreme params', () => {
    const result = scaleStepsPerSec({ stepsPerSec: 0.001, paramsB: 0.1, tokensPerStep: 1 },
      profile({ paramsB: 1000 }), undefined);
    expect(result).toBeGreaterThanOrEqual(0.01);
  });
});

// ─── detectParamsFromHfConfig ─────────────────────────────────────────────────

describe('detectParamsFromHfConfig', () => {
  it('returns undefined for empty config', () => {
    expect(detectParamsFromHfConfig({})).toBeUndefined();
  });

  it('uses num_parameters directly', () => {
    const result = detectParamsFromHfConfig({ num_parameters: 7_000_000_000 });
    expect(result).toBeCloseTo(7, 1);
  });

  it('uses n_params directly', () => {
    const result = detectParamsFromHfConfig({ n_params: 1_000_000_000 });
    expect(result).toBeCloseTo(1, 1);
  });

  it('uses total_params directly', () => {
    const result = detectParamsFromHfConfig({ total_params: 3_500_000_000 });
    expect(result).toBeCloseTo(3.5, 1);
  });

  it('derives from hidden_size + num_hidden_layers', () => {
    const result = detectParamsFromHfConfig({
      hidden_size: 4096,
      num_hidden_layers: 32,
      vocab_size: 32000,
    });
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(0);
  });

  it('derives from n_embd + n_layer', () => {
    const result = detectParamsFromHfConfig({ n_embd: 768, n_layer: 12 });
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(0);
  });

  it('returns undefined when only vocab_size is present', () => {
    expect(detectParamsFromHfConfig({ vocab_size: 32000 })).toBeUndefined();
  });

  it('returns undefined for zero/negative num_parameters', () => {
    expect(detectParamsFromHfConfig({ num_parameters: 0 })).toBeUndefined();
    expect(detectParamsFromHfConfig({ num_parameters: -1 })).toBeUndefined();
  });
});

// ─── precisionFromHint ───────────────────────────────────────────────────────

describe('precisionFromHint', () => {
  it('returns fallback for undefined', () => {
    expect(precisionFromHint(undefined)).toBe('bf16');
  });

  it('returns custom fallback for undefined', () => {
    expect(precisionFromHint(undefined, 'fp16')).toBe('fp16');
  });

  it('recognizes int4', () => {
    expect(precisionFromHint('int4')).toBe('int4');
  });

  it('recognizes 4-bit', () => {
    expect(precisionFromHint('4-bit')).toBe('int4');
  });

  it('recognizes nf4', () => {
    expect(precisionFromHint('nf4')).toBe('int4');
  });

  it('recognizes qlora hint', () => {
    expect(precisionFromHint('qlora')).toBe('int4');
  });

  it('recognizes int8', () => {
    expect(precisionFromHint('int8')).toBe('int8');
  });

  it('recognizes 8-bit', () => {
    expect(precisionFromHint('8-bit')).toBe('int8');
  });

  it('recognizes fp32', () => {
    expect(precisionFromHint('fp32')).toBe('fp32');
  });

  it('recognizes float32', () => {
    expect(precisionFromHint('float32')).toBe('fp32');
  });

  it('recognizes fp16', () => {
    expect(precisionFromHint('fp16')).toBe('fp16');
  });

  it('recognizes float16', () => {
    expect(precisionFromHint('float16')).toBe('fp16');
  });

  it('returns fallback for unknown hint', () => {
    expect(precisionFromHint('bf8')).toBe('bf16');
  });

  it('is case-insensitive', () => {
    expect(precisionFromHint('INT4')).toBe('int4');
    expect(precisionFromHint('FP32')).toBe('fp32');
  });
});
