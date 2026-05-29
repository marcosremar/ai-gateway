/**
 * Finetune spec validation and normalization.
 * Single source of truth — called before any async work.
 */

import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { FinetuneOpts, ValidationResult, Preset, PresetManifest, Project, ProjectManifest } from './types.js';
import { BUNDLED_PLUGINS } from './types.js';

// ─── Numeric bounds ─────────────────────────────────────────────────────────

const NUMERIC_BOUNDS: Array<[string, keyof FinetuneOpts, number, number]> = [
  ['maxCost', 'maxCost', 0.01, 50],
  ['maxSpend', 'maxSpend', 0.01, 100],
  ['epochs', 'epochs', 1, 100],
  ['lr', 'lr', 1e-9, 1],
  ['numGpus', 'numGpus', 1, 8],
  ['retryOnPreempt', 'retryOnPreempt', 0, 10],
  ['ckptAverage', 'ckptAverage', 2, 50],
  ['batchSize', 'batchSize', 1, 64],
  ['gradAccum', 'gradAccum', 1, 256],
  ['freezeBackboneLayers', 'freezeBackboneLayers', 0, 64],
  ['warmupSteps', 'warmupSteps', 0, 10000],
  ['weightDecay', 'weightDecay', 0, 1],
  ['saveEverySteps', 'saveEverySteps', 1, 100_000],
  ['gradClip', 'gradClip', 0.001, 100],
  ['logEverySteps', 'logEverySteps', 1, 10000],
  ['rewindThreshold', 'rewindThreshold', 1.5, 100],
  ['plateauTolerance', 'plateauTolerance', 0, 1],
  ['autoStopPlateau', 'autoStopPlateau', 0, 100000],
];

// ─── Preset loader ──────────────────────────────────────────────────────────

let _presets: Map<string, Preset> | null = null;
let _presetsRoot: string | null = null;

function defaultPresetsRoot(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  return resolve(selfDir, '../../../finetune-presets');
}

/** Override presets directory (test injection). Pass null to reset to default. */
export function setPresetsRoot(root: string | null): void {
  _presetsRoot = root;
  _presets = null;
}

function getPresetMap(): Map<string, Preset> {
  if (_presets) return _presets;
  _presets = new Map();
  const root = _presetsRoot ?? defaultPresetsRoot();
  if (!existsSync(root)) return _presets;
  for (const entry of readdirSync(root)) {
    const dir = resolve(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const mf = resolve(dir, 'manifest.json');
    if (!existsSync(mf)) continue;
    try {
      const manifest = JSON.parse(readFileSync(mf, 'utf-8')) as PresetManifest;
      _presets.set(entry, { manifest, dir });
    } catch { /* skip malformed */ }
  }
  return _presets;
}

export function loadPreset(type: string | undefined | null): Preset | undefined {
  if (!type || typeof type !== 'string') return undefined;
  return getPresetMap().get(type);
}

export function listPresets(): Preset[] {
  return [...getPresetMap().values()];
}

// ─── Project loader ──────────────────────────────────────────────────────────

let _projects: Map<string, Project> | null = null;
let _projectsRoot: string | null = null;

function defaultProjectsRoot(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  return resolve(selfDir, '../../../finetune-projects');
}

/** Override projects directory (test injection). Pass null to reset to default. */
export function setProjectsRoot(root: string | null): void {
  _projectsRoot = root;
  _projects = null;
}

function getProjectMap(): Map<string, Project> {
  if (_projects) return _projects;
  _projects = new Map();
  const root = _projectsRoot ?? defaultProjectsRoot();
  if (!existsSync(root)) return _projects;
  for (const entry of readdirSync(root)) {
    const dir = resolve(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const mf = resolve(dir, 'project.json');
    if (!existsSync(mf)) continue;
    try {
      const manifest = JSON.parse(readFileSync(mf, 'utf-8')) as ProjectManifest;
      _projects.set(entry, { manifest, dir });
    } catch { /* skip malformed */ }
  }
  return _projects;
}

export function loadProject(name: string | undefined | null): Project | undefined {
  if (!name || typeof name !== 'string') return undefined;
  return getProjectMap().get(name);
}

export function listProjects(): Project[] {
  return [...getProjectMap().values()];
}

/**
 * Given opts with a project field, merge project defaults into opts and resolve
 * the preset name from the project manifest. Returns augmented opts + the
 * resolved project + preset.
 */
export function resolveProjectOpts(opts: Partial<FinetuneOpts>): {
  opts: Partial<FinetuneOpts>;
  project: Project | undefined;
  preset: Preset | undefined;
} {
  const project = loadProject(opts.project);
  if (!project) return { opts, project: undefined, preset: undefined };

  const m = project.manifest;
  const merged: Partial<FinetuneOpts> = {
    ...opts,
    // project defaults applied only if caller didn't specify
    model:     opts.model     ?? m.model,
    dataset:   opts.dataset   ?? m.defaultDataset,
    epochs:    opts.epochs    ?? m.defaultEpochs,
    lr:        opts.lr        ?? m.defaultLR,
    gpu:       opts.gpu       ?? m.defaultGpu,
    maxSpend:  opts.maxSpend  ?? m.defaultMaxSpend,
    // type comes from preset, not caller — overwrite
    type: (opts.type !== undefined && !opts.project ? opts.type : m.preset) as FinetuneOpts['type'],
  };

  const preset = loadPreset(m.preset);
  return { opts: merged, project, preset };
}

// ─── Main validator ────────────────────────────────────────────────────────

export function validateSpec(spec: Partial<FinetuneOpts>): ValidationResult {
  const errs: string[] = [];

  // ── Structural ──
  // If project is set, resolve through it; otherwise resolve type directly.
  let effectiveSpec = spec;
  if (spec.project) {
    const { opts, project } = resolveProjectOpts(spec);
    if (!project) {
      errs.push(`unknown project '${spec.project}' — run 'ai-gateway gpu finetune projects' to list available`);
    }
    effectiveSpec = opts;
  }

  const preset = loadPreset(effectiveSpec.type ?? '');
  const hasPreset = !!preset;

  if (!effectiveSpec.scriptPath && !hasPreset) {
    errs.push('missing required: script (or use a built-in preset type or project)');
  }
  if (effectiveSpec.scriptPath && hasPreset) {
    errs.push(`cannot set both 'type: ${effectiveSpec.type}' (preset) AND 'script: …'. Pick one.`);
  }
  if (spec.smoke === true && spec.skipSmoke === true) {
    errs.push(`cannot set both smoke:true and skipSmoke:true — pick one`);
  }
  if (effectiveSpec.type && !hasPreset && !['text', 'audio', 'custom'].includes(effectiveSpec.type)) {
    errs.push(`type must be text|audio|custom OR a preset/project name (got '${effectiveSpec.type}')`);
  }

  // ── HF refs — validate using effective (post-project-merge) values ──
  if (effectiveSpec.dataset && !effectiveSpec.dataset.startsWith('hf://')) {
    errs.push('dataset must use hf://owner/repo form');
  }
  if (effectiveSpec.model && !effectiveSpec.model.startsWith('hf://')) {
    errs.push('model must use hf://owner/repo form');
  }
  if (!effectiveSpec.dataset && (hasPreset || effectiveSpec.type === 'audio' || effectiveSpec.type === 'text')) {
    errs.push('missing required: dataset (hf://owner/repo)');
  }
  if (spec.pushToHf && !spec.pushToHf.includes('/')) {
    errs.push('pushToHf must be \'owner/repo\'');
  }
  if (spec.hfBase && !spec.hfBase.includes('/')) {
    errs.push('hfBase must be \'owner/name\'');
  }
  if (spec.fromHf && !spec.fromHf.includes('/')) {
    errs.push('fromHf must be \'owner/name\'');
  }
  if (spec.hfStructure && !['flat', 'split', 'tri'].includes(spec.hfStructure)) {
    errs.push(`hfStructure must be flat|split|tri (got ${spec.hfStructure})`);
  }

  // ── R2 / S3 durable storage ──
  if (spec.r2Bucket !== undefined) {
    if (typeof spec.r2Bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(spec.r2Bucket)) {
      errs.push(`r2Bucket must be a valid bucket name (lowercase, 3-63 chars, [a-z0-9.-]) — got '${spec.r2Bucket}'`);
    }
  }
  if (spec.r2Prefix !== undefined && (typeof spec.r2Prefix !== 'string' || spec.r2Prefix.startsWith('/'))) {
    errs.push(`r2Prefix must be a string without a leading slash (e.g. 'jobs/my-run')`);
  }
  if (spec.resumeFromR2 && !spec.r2Bucket) {
    errs.push('resumeFromR2 requires r2Bucket to be set');
  }

  // ── Providers ──
  if (spec.providers !== undefined) {
    if (!Array.isArray(spec.providers)) {
      errs.push('providers must be an array');
    } else {
      const ALLOWED = ['vast', 'runpod', 'tensordock', 'modal', 'hyperstack'];
      const bad = (spec.providers as string[]).filter(p => !ALLOWED.includes(p));
      if (bad.length) errs.push(`providers contains unknown: ${bad.join(', ')} (allowed: ${ALLOWED.join('|')})`);
    }
  }

  // ── Numeric bounds ──
  for (const [name, key, lo, hi] of NUMERIC_BOUNDS) {
    const val = spec[key];
    if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val) || val < lo || val > hi)) {
      errs.push(`${name}=${val} out of range [${lo}, ${hi}]`);
    }
  }

  // ── Special cases ──
  if (spec.maxSpend !== undefined && spec.maxSpend > 100) {
    errs.push('maxSpend > $100 — refusing as safety guard');
  }
  if (spec.quality && !['auto', 'safe', 'fast'].includes(spec.quality)) {
    errs.push(`quality must be auto|safe|fast (got ${spec.quality})`);
  }
  if (spec.curriculum !== undefined && spec.curriculum !== '' && spec.curriculum !== 'linear') {
    errs.push(`curriculum must be '' (random) or 'linear' (got '${spec.curriculum}')`);
  }

  // ── Plugin ──
  if (spec.plugin && !BUNDLED_PLUGINS[spec.plugin]) {
    errs.push(`unknown plugin '${spec.plugin}' — available: ${Object.keys(BUNDLED_PLUGINS).join(', ')}`);
  }

  // ── dataset-include warning for presets ──
  const dsInc = spec.datasetInclude;
  const prepareDirective = spec.prepare ?? 'auto';
  if (dsInc && hasPreset && prepareDirective === 'auto') {
    const globs = dsInc.split(',').map(g => g.trim());
    const hasMeta = globs.some(g =>
      g === 'metadata.jsonl' || g === 'train.jsonl' || g === '*.jsonl' ||
      (g.endsWith('/*') === false && g.endsWith('jsonl')));
    if (!hasMeta) {
      errs.push(
        `dataset-include='${dsInc}' may exclude metadata.jsonl/train.jsonl that ` +
        `auto-prep needs. Add 'metadata.jsonl' or set prepare:skip`);
    }
  }

  return { valid: errs.length === 0, errors: errs };
}

// ─── Numeric checks for CLI (no Process.exit in lib) ───────────────────────

export interface NumericCheckResult {
  ok: boolean;
  name: string;
  value: number;
  lo: number;
  hi: number;
}

export function runNumericChecks(
  opts: Partial<FinetuneOpts>
): NumericCheckResult[] {
  const checks: Array<[string, number | undefined, number, number]> = [
    ['--max-cost / maxCost', opts.maxCost, 0.01, 50],
    ['--max-spend / maxSpend', opts.maxSpend, 0.01, 100],
    ['--epochs / epochs', opts.epochs, 1, 100],
    ['--lr / lr', opts.lr, 1e-9, 1],
    ['--num-gpus / numGpus', opts.numGpus, 1, 8],
  ];
  return checks.map(([name, val, lo, hi]) => ({
    ok: val === undefined || (Number.isFinite(val!) && val! >= lo && val! <= hi),
    name,
    value: val ?? NaN,
    lo,
    hi,
  }));
}
