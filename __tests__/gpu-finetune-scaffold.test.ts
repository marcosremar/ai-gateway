import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scaffoldPreset, STD_PATHS } from '../src/gpu-finetune/scaffold';
import {
  validateSpec, loadPreset, setPresetsRoot, lintPresetManifest,
} from '../src/gpu-finetune/spec';
import type { PresetManifest } from '../src/gpu-finetune/types';

describe('scaffoldPreset', () => {
  afterEach(() => setPresetsRoot(null));

  it('emits manifest.json + trainer.py + prepare_dataset.py', () => {
    const files = scaffoldPreset('my-preset');
    expect(files.map(f => f.rel).sort()).toEqual(['manifest.json', 'prepare_dataset.py', 'trainer.py']);
  });

  it('generated manifest is valid JSON with the trainer contract + std paths', () => {
    const files = scaffoldPreset('demo', { type: 'text', defaultModel: 'hf://owner/base' });
    const mf = JSON.parse(files.find(f => f.rel === 'manifest.json')!.contents) as PresetManifest;
    expect(mf.name).toBe('demo');
    expect(mf.type).toBe('text');
    expect(mf.defaultModel).toBe('hf://owner/base');
    expect(mf.trainerInterface.train).toContain(STD_PATHS.checkpoints);
    expect(mf.trainerInterface.encode).toContain(STD_PATHS.encoded);
    // lint must be clean for a freshly scaffolded manifest
    expect(lintPresetManifest(mf)).toEqual([]);
  });

  it('generated trainer.py implements encode + train subcommands + resume + step ckpts', () => {
    const trainer = scaffoldPreset('demo').find(f => f.rel === 'trainer.py')!.contents;
    expect(trainer).toContain('add_parser("encode")');
    expect(trainer).toContain('add_parser("train")');
    expect(trainer).toContain('--resume');
    expect(trainer).toContain('step-');           // step-N.safetensors convention
    expect(trainer).toContain('parse_known_args'); // tolerates extra auto-flags
    expect(trainer).toContain('IARATTS_HF_WEIGHTS_REPO');
    expect(trainer).toContain('[calib] steps_per_sec='); // self-calibration emit
  });

  it('rejects invalid preset names', () => {
    expect(() => scaffoldPreset('Bad Name')).toThrow(/kebab-case/);
    expect(() => scaffoldPreset('UPPER')).toThrow();
    expect(() => scaffoldPreset('-leading')).toThrow();
  });

  it('a written scaffold loads + validates as a real preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'scaffold-'));
    try {
      const name = 'roundtrip';
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      for (const f of scaffoldPreset(name, { type: 'audio' })) {
        writeFileSync(join(dir, f.rel), f.contents);
      }
      setPresetsRoot(root);
      const preset = loadPreset(name);
      expect(preset?.manifest.name).toBe(name);
      // validateSpec should accept type=<preset> + a dataset, no errors
      const res = validateSpec({ type: name as never, dataset: 'hf://you/data' });
      expect(res.valid).toBe(true);
    } finally {
      setPresetsRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('lintPresetManifest', () => {
  const base: PresetManifest = {
    name: 'x', version: '1', description: 'd', type: 'audio',
    trainerScript: 'trainer.py', trainerInterface: { train: 'python trainer.py train' },
  };

  it('clean manifest yields no warnings', () => {
    expect(lintPresetManifest(base)).toEqual([]);
  });

  it('flags unknown probePaths keys', () => {
    const w = lintPresetManifest({ ...base, probePaths: { checkpointsDir: '/x', bogusKey: '/y' } as never });
    expect(w.some(s => s.includes('bogusKey'))).toBe(true);
  });

  it('flags missing trainerInterface.train', () => {
    const w = lintPresetManifest({ ...base, trainerInterface: {} as never });
    expect(w.some(s => s.includes('trainerInterface.train'))).toBe(true);
  });
});
