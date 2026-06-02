/**
 * gpu-finetune module — unit tests for spec validation, cost estimation,
 * status parsing, compare output parsing, and shell-script composition.
 *
 * No external dependencies; preset loader is exercised against the real
 * `finetune-presets/` tree in this repo (read-only).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateSpec,
  estimateCost,
  parseProbeOutput,
  detectStage,
  buildStatusResult,
  buildProbeCommand,
  parseCompareOutput,
  deriveFinetuneHttpStatus,
  readFinetuneJobLogs,
  loadPreset,
  listPresets,
  setPresetsRoot,
  runNumericChecks,
  FinetuneGateway,
  InMemoryFinetuneState,
  FileFinetuneState,
  BUNDLED_PLUGINS,
  DEFAULT_VAST_SSH_BOOT_TIMEOUT_SEC,
  resolveVastSshAcquisitionPolicy,
} from '../src/modules/gpu-finetune';
import type {
  GpuJobRunner,
  FinetuneProbe,
  FinetuneOpts,
  GpuJobResult,
} from '../src/modules/gpu-finetune';

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

  it('requires a smoke gate before expensive full runs unless explicitly overridden', () => {
    const blocked = validateSpec({
      type: 'audio',
      scriptPath: '/tmp/x.py',
      dataset: 'hf://a/b',
      skipSmoke: true,
      maxSpend: 10,
    });
    expect(blocked.valid).toBe(false);
    expect(blocked.errors.some(e => e.includes('skipSmoke is blocked'))).toBe(true);

    const allowed = validateSpec({
      type: 'audio',
      scriptPath: '/tmp/x.py',
      dataset: 'hf://a/b',
      skipSmoke: true,
      maxSpend: 10,
      allowSkipSmokeForExpensive: true,
    });
    expect(allowed.errors.some(e => e.includes('skipSmoke is blocked'))).toBe(false);
  });

  it('validates R2 auto-resume and sync interval knobs', () => {
    const missingBucket = validateSpec({ type: 'audio', scriptPath: '/tmp/x.py', dataset: 'hf://a/b', autoResumeR2: true });
    expect(missingBucket.errors).toContain('autoResumeR2 requires r2Bucket to be set');
    const badInterval = validateSpec({
      type: 'audio',
      scriptPath: '/tmp/x.py',
      dataset: 'hf://a/b',
      r2Bucket: 'tts-ptbr-training',
      r2SyncIntervalSec: -1,
    });
    expect(badInterval.errors.some(e => e.includes('r2SyncIntervalSec=-1'))).toBe(true);
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

// ─── Vast SSH acquisition policy ───────────────────────────────────────

describe('resolveVastSshAcquisitionPolicy', () => {
  it('uses a 600s serial acquisition timeout for Vast RTX 5090 jobs by default', () => {
    expect(DEFAULT_VAST_SSH_BOOT_TIMEOUT_SEC).toBe(600);
    const policy = resolveVastSshAcquisitionPolicy({
      provider: 'vast',
      gpuFilter: '5090',
      gpuName: 'NVIDIA GeForce RTX 5090',
      env: {},
    });
    expect(policy).toMatchObject({
      enabled: true,
      reason: 'vast-5090-ssh-acquisition',
      bootTimeoutSec: DEFAULT_VAST_SSH_BOOT_TIMEOUT_SEC,
    });
  });

  it('leaves non-5090 Vast jobs on the normal minute-based boot policy', () => {
    const policy = resolveVastSshAcquisitionPolicy({
      provider: 'vast',
      gpuFilter: '4090',
      gpuName: 'NVIDIA GeForce RTX 4090',
      env: {},
    });
    expect(policy).toMatchObject({
      enabled: false,
      reason: 'vast-non-5090',
    });
    expect(policy.bootTimeoutSec).toBeUndefined();
  });

  it('honors env timeout overrides for Vast RTX 5090 jobs', () => {
    const policy = resolveVastSshAcquisitionPolicy({
      provider: 'vast',
      gpuFilter: 'RTX 5090',
      env: {
        AIGW_VAST_SSH_BOOT_TIMEOUT_SEC: '60',
      },
    });
    expect(policy.bootTimeoutSec).toBe(60);
  });

  it('caps explicit timeout overrides', () => {
    const policy = resolveVastSshAcquisitionPolicy({
      provider: 'vast',
      gpuFilter: 'RTX 5090',
      requestedBootTimeoutSec: 900,
      env: {
        AIGW_VAST_SSH_BOOT_TIMEOUT_SEC: '60',
      },
    });
    expect(policy.bootTimeoutSec).toBe(600);
  });
});

// ─── CLI wiring invariants ─────────────────────────────────────────────

describe('gpu jobs CLI acquisition wiring', () => {
  const cliSource = () => readFileSync(join(process.cwd(), 'bin/ai-gateway.ts'), 'utf-8');

  it('passes Vast SSH acquisition policy and seconds timeout into deploy/readiness flow', () => {
    const src = cliSource();
    expect(src).toContain('resolveVastSshAcquisitionPolicy');
    expect(src).toMatch(/if \(typeof opts\.raceCount === 'number'\) deployBody\.raceCount = opts\.raceCount/);
    expect(src).toMatch(/const requestedBootTimeoutSec\s*=\s*opts\.bootTimeoutSec\s*\?\?\s*acquisitionPolicy\.bootTimeoutSec/);
    expect(src).toMatch(/deployBody\.bootTimeoutSec\s*=\s*requestedBootTimeoutSec/);
    expect(src).toMatch(/deployBody\.provider\s*=\s*selectedProvider/);
    expect(src).toMatch(/deployBody\.requireDirectPort\s*=\s*true/);
    expect(src).toMatch(/parallelSlot:\s*rOpts\.parallelSlot/);
    expect(src).toMatch(/storageGb:\s*rOpts\.storageGb/);
    expect(src).toContain('SSH acquisition serial');
  });

  it('keeps deploy-level race capped without the removed Vast acquisition knob', () => {
    const serverSrc = readFileSync(join(process.cwd(), 'server/gpu-handlers.ts'), 'utf-8');
    const cliSrc = cliSource();
    const lifecycleSrc = readFileSync(join(process.cwd(), 'server/handlers/gpu/lifecycle.ts'), 'utf-8');
    const vastSrc = readFileSync(join(process.cwd(), 'src/gateway/providers/gpu/vast-client.ts'), 'utf-8');
    const moduleVastSrc = readFileSync(join(process.cwd(), 'src/modules/gateway/providers/gpu/vast-client.ts'), 'utf-8');
    expect(serverSrc).not.toContain('Vast.ai deploy race disabled');
    const removedKnob = 'offer' + 'RaceCount';
    expect(serverSrc).not.toContain(removedKnob);
    expect(cliSrc).not.toContain(removedKnob);
    expect(cliSrc).not.toContain('--offer-' + 'race-count');
    expect(lifecycleSrc).not.toContain('Vast.ai deploy race disabled');
    expect(lifecycleSrc).toContain('if (body.race)');
    expect(vastSrc).toContain('const raceCount = Math.min(requestedRaceCount, VAST_MAX_OFFER_RACE_COUNT)');
    expect(moduleVastSrc).toContain('const raceCount = Math.min(requestedRaceCount, VAST_MAX_OFFER_RACE_COUNT)');
    expect(vastSrc).toContain('Staggered hedge deploy');
    expect(moduleVastSrc).toContain('Staggered hedge deploy');
    expect(vastSrc).not.toContain('const defaultOfferRace');
    expect(moduleVastSrc).not.toContain('const _defaultRace');
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
    expect(main).toContain('HF_XET_HIGH_PERFORMANCE=1');
    expect(main).toContain('HF_HUB_DOWNLOAD_TIMEOUT=30');
    expect(main).toContain('[diag] job bootstrap diagnostics');
    expect(main).toContain('hf_token_present=');
    expect(main).toContain("getent ahosts 'huggingface.co'");
    expect(main).toContain('prefer IPv4 enabled via /etc/gai.conf');
    expect(main).not.toContain('HF_HUB_ENABLE_HF_TRANSFER');
    expect(main).toContain('( { pip install');
    expect(main).toContain('; wait $__PIP');
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
    delete process.env.AIGW_STORAGE_REMOTE;
    try {
      const gw = makeGateway();
      const { main } = gw.compose({
        type: 'flow-matching-tts', dataset: 'hf://foo/bar',
        r2Bucket: 'tts-ptbr-training', r2Prefix: 'jobs/my-run', resumeFromR2: true,
      });
      // rclone remote env injected
      expect(main).toContain('RCLONE_CONFIG_R2AIGW_ACCESS_KEY_ID');
      expect(main).toContain('RCLONE_CONFIG_R2AIGW_PROVIDER=Cloudflare');
      expect(main).toContain('export RCLONE_BIND=0.0.0.0');
      expect(main).toContain('export RCLONE_CONNECT_TIMEOUT=10s');
      expect(main).toContain('export RCLONE_LOW_LEVEL_RETRIES=20');
      expect(main).toContain('rclone_remote=r2aigw');
      // restore before train
      expect(main).toContain('rclone copy r2aigw:tts-ptbr-training/jobs/my-run/checkpoints /workspace/checkpoints');
      // resume forced
      expect(main).toContain('--resume /workspace/checkpoints');
      expect(main).toContain('[r2] live sync a cada 180s');
      expect(main).toContain('aigw_manifest.jsonl');
      // final backup after push
      expect(main).toContain('rclone sync /workspace/checkpoints r2aigw:tts-ptbr-training/jobs/my-run/checkpoints');
    } finally {
      process.env = saved;
    }
  });

  it('uses generic S3 provider for Backblaze B2 endpoints', () => {
    const saved = { ...process.env };
    process.env.B2_ACCOUNT_ID = 'ak_test';
    process.env.B2_APPLICATION_KEY = 'sk_test';
    process.env.B2_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com';
    process.env.B2_REGION = 'us-east-005';
    try {
      const gw = makeGateway();
      const { main } = gw.compose({
        type: 'flow-matching-tts', dataset: 'hf://foo/bar',
        r2Bucket: 'tts-ptbr-training', r2Prefix: 'jobs/my-run', resumeFromR2: true,
      });
      expect(main).toContain('RCLONE_CONFIG_B2AIGW_PROVIDER=Other');
      expect(main).toContain("RCLONE_CONFIG_B2AIGW_ENDPOINT='https://s3.us-east-005.backblazeb2.com'");
      expect(main).toContain('export RCLONE_BIND=0.0.0.0');
      expect(main).toContain("getent ahosts 's3.us-east-005.backblazeb2.com'");
      expect(main).toContain('rclone copy b2aigw:tts-ptbr-training/jobs/my-run/checkpoints /workspace/checkpoints');
    } finally {
      process.env = saved;
    }
  });

  it('derives Backblaze B2 endpoint from B2_REGION when B2 key id aliases are used', () => {
    const saved = { ...process.env };
    delete process.env.B2_ACCOUNT_ID;
    delete process.env.B2_ENDPOINT;
    process.env.B2_KEY_ID = 'b2_key_id_test';
    process.env.B2_APPLICATION_KEY = 'sk_test';
    process.env.B2_REGION = 'eu-central-003';
    try {
      const gw = makeGateway();
      const { main } = gw.compose({
        type: 'flow-matching-tts', dataset: 'hf://foo/bar',
        r2Bucket: 'tts-ptbr-training', r2Prefix: 'jobs/my-run', resumeFromR2: true,
      });
      expect(main).toContain('RCLONE_CONFIG_B2AIGW_PROVIDER=Other');
      expect(main).toContain("RCLONE_CONFIG_B2AIGW_ENDPOINT='https://s3.eu-central-003.backblazeb2.com'");
    } finally {
      process.env = saved;
    }
  });

  it('auto-restores from R2 by default when r2Bucket is set', () => {
    const saved = { ...process.env };
    process.env.B2_ACCOUNT_ID = 'ak_test';
    process.env.B2_APPLICATION_KEY = 'sk_test';
    process.env.B2_ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
    try {
      const gw = makeGateway();
      const { main } = gw.compose({
        type: 'flow-matching-tts',
        dataset: 'hf://foo/bar',
        r2Bucket: 'tts-ptbr-training',
        r2Prefix: 'jobs/auto',
        r2SyncIntervalSec: 30,
      });
      expect(main).toContain('[r2] checando checkpoints para resume');
      expect(main).toContain('--resume /workspace/checkpoints');
      expect(main).toContain('[r2] live sync a cada 30s');
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

  it('passes operational runtime knobs through to the job runner', async () => {
    const runner = new MockRunner();
    const gw = new FinetuneGateway({
      stateStore: new InMemoryFinetuneState(),
      hfToken: new MockHf(),
      jobRunner: runner,
      probe: new MockProbe(),
      log: silentLog,
    });
    await gw.run({
      type: 'flow-matching-tts',
      dataset: 'hf://foo/bar',
      timeoutMin: 12,
      bootTimeoutMin: 4,
      bootTimeoutSec: 90,
      raceCount: 2,
      parallelSlot: 'slot-a',
      storageGb: 80,
      pullEveryMin: 0,
      stallMin: 5,
      pullExclude: ['dataset-cache/'],
    });
    expect(runner.calls[0]).toMatchObject({
      timeoutMin: 12,
      bootTimeoutMin: 4,
      bootTimeoutSec: 90,
      raceCount: 2,
      parallelSlot: 'slot-a',
      storageGb: 80,
      pullEveryMin: 0,
      stallMin: 5,
      pullExclude: ['dataset-cache/'],
    });
  });
});

// ─── HTTP job log/status helpers ───────────────────────────────────────

describe('fine-tune HTTP job status helpers', () => {
  it('redacts R2 secrets and recognizes VUI-style checkpoints', () => {
    const savedEnv = { ...process.env };
    const dir = mkdtempSync(join(tmpdir(), 'finetune-job-'));
    try {
      delete process.env.AIGW_STORAGE_REMOTE;
      delete process.env.B2_ENDPOINT;
      delete process.env.R2_ENDPOINT;
      const logPath = join(dir, 'job.log');
      writeFileSync(logPath, [
        "export RCLONE_CONFIG_R2AIGW_SECRET_ACCESS_KEY='super-secret'",
        "export RCLONE_CONFIG_R2AIGW_ACCESS_KEY_ID='access-key'",
        'Starting training: 2 steps',
        '  saved /workspace/checkpoints/erinome_step2.pt',
        '  job exit code: 0',
      ].join('\n'));
      const record = {
        jobId: 'ft-test',
        status: 'running' as const,
        spec: { r2Bucket: 'tts-ptbr-training', r2Prefix: 'smoke/full-flow' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:10:00.000Z',
        pricePerHr: 0.6,
        instanceId: 'inst-1',
        specPath: join(dir, 'spec.json'),
        logPath,
        exitPath: join(dir, 'exit.json'),
      };
      const logs = readFinetuneJobLogs(record);
      expect(logs).toContain('RCLONE_CONFIG_R2AIGW_SECRET_ACCESS_KEY=[redacted]');
      expect(logs).toContain('RCLONE_CONFIG_R2AIGW_ACCESS_KEY_ID=[redacted]');
      expect(logs).not.toContain('super-secret');
      expect(logs).not.toContain('access-key');
      const status = deriveFinetuneHttpStatus(record, logs);
      expect(status.status).toBe('completed');
      expect(status.checkpoints).toContain('erinome_step2.pt');
      expect(status.r2CheckpointUrl).toBe('r2aigw:tts-ptbr-training/smoke/full-flow/checkpoints');
      expect(status.elapsedSec).toBe(600);
      expect(status.estimatedCostUsd).toBeCloseTo(0.1, 5);
      expect(status.phasesSeen).toContain('training');
    } finally {
      process.env = savedEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses configured B2 remote in derived checkpoint URLs', () => {
    const savedEnv = { ...process.env };
    try {
      process.env.AIGW_STORAGE_REMOTE = 'b2aigw';
      const status = deriveFinetuneHttpStatus({
        jobId: 'ft-b2',
        status: 'running' as const,
        spec: { r2Bucket: 'omni-speech-dataset', r2Prefix: 'tts-ptbr-training/ckpts/run-1' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        specPath: '/tmp/spec.json',
        logPath: '/tmp/job.log',
        exitPath: '/tmp/exit.json',
      }, 'Starting training');
      expect(status.r2CheckpointUrl).toBe('b2aigw:omni-speech-dataset/tts-ptbr-training/ckpts/run-1/checkpoints');
    } finally {
      process.env = savedEnv;
    }
  });
});
