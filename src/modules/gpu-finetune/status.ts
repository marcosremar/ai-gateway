/**
 * Finetune status — probe parsing and status result builder.
 * Does NOT make network calls; expects caller to run the probe and pass output.
 *
 * Stage-detection regexes + probe filesystem paths are pluggable via the
 * StageDetectorPatterns / ProbePathsSpec interfaces (sourced from preset
 * manifest). Defaults match pocket-tts layout for back-compat.
 */

import type { FinetuneStage, FinetuneStatusResult, StageDetectorPatterns, ProbePathsSpec } from './types.js';

const SEP = '__AIGWPROBE__';

export interface ProbeOutput {
  procs: string;
  files: string;
  loss: string;
  gpu: string;
  disk: string;
}

/** Parse raw SSH probe output into structured sections. */
export function parseProbeOutput(raw: string): ProbeOutput {
  const sectionMap: Record<string, string> = {};
  const parts = raw.split(SEP);
  for (let i = 1; i < parts.length - 1; i += 2) {
    sectionMap[parts[i].trim()] = (parts[i + 1] || '').trim();
  }
  return {
    procs: sectionMap['procs'] || '',
    files: sectionMap['files'] || '',
    loss: sectionMap['loss'] || '',
    gpu: sectionMap['gpu'] || '0,0,0',
    disk: sectionMap['disk'] || '',
  };
}

// Use space-delimited word boundaries so e.g. `train --tokens /root/encoded.pt`
// does NOT match the encode pattern via the path substring.
const DEFAULT_PATTERNS: Required<StageDetectorPatterns> = {
  download: 'python\\d?\\s+/\\S+hf\\s+download|^hf download',
  prepare: 'python.*\\bprepare_dataset\\b',
  encode: 'python\\b.* encode(\\s|$)|python\\b.*encode_multi_gpu',
  train: 'python\\b.* train(\\s|$)',
};

/** Detect running stage from process list + file artifacts. */
export function detectStage(
  probe: ProbeOutput,
  patterns: StageDetectorPatterns = {},
): { stage: FinetuneStage; detail: string } {
  const { procs, files, loss } = probe;
  const merged = { ...DEFAULT_PATTERNS, ...patterns };

  const procLines = procs.split('\n').filter(l => l.trim());
  // Strip ps metadata, keep only CMD+args
  const cmds = procLines
    .map(l => l.replace(/^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/, ''))
    .filter(c => !c.startsWith('bash -c'));

  const hasProc = (re: RegExp) => cmds.some(c => re.test(c));

  if (hasProc(new RegExp(merged.download))) {
    const wavMatch = files.match(/^\d+/m);
    const wavCount = wavMatch ? parseInt(wavMatch[0]) : 0;
    return { stage: 'downloading', detail: wavCount > 0 ? `${wavCount} wavs cached` : '' };
  }
  if (hasProc(new RegExp(merged.prepare))) {
    return { stage: 'preparing', detail: '' };
  }
  if (hasProc(new RegExp(merged.encode))) {
    const rateLine = loss.split('\n').find(l => l.startsWith('rate='));
    return { stage: 'encoding', detail: rateLine || '' };
  }
  if (hasProc(new RegExp(merged.train))) {
    const stepLine = [...loss.split('\n')].reverse().find(l => l.startsWith('step='));
    const lossLine = [...loss.split('\n')].reverse().find(l => l.startsWith('loss='));
    return {
      stage: 'training',
      detail: [stepLine, lossLine].filter(Boolean).join('  '),
    };
  }
  if (hasProc(/python -c/)) {
    return { stage: 'smoke-verify', detail: '' };
  }
  if (procLines.length === 0) {
    if (files.includes('.safetensors') || files.includes('model.safetensors')) {
      return { stage: 'completed', detail: '' };
    }
    return { stage: 'idle', detail: '' };
  }
  return { stage: '?', detail: '' };
}

/** Build a FinetuneStatusResult from raw probe data + job metadata. */
export function buildStatusResult(
  probe: ProbeOutput,
  jobMeta: {
    instanceId: string;
    gpuType: string;
    provider: string;
    pricePerHr: number;
    startedAt: string;
  },
  patterns: StageDetectorPatterns = {},
): FinetuneStatusResult {
  const { stage, detail } = detectStage(probe, patterns);

  const gpuLine = probe.gpu.split('\n').find(Boolean) || '0,0,0';
  const [gpuPct = 0, vramUsed = 0, vramTotal = 0] = gpuLine.split(',').map(Number);

  const startedMs = new Date(jobMeta.startedAt).getTime();
  const elapsedMin = (Date.now() - startedMs) / 60_000;
  const spent = (elapsedMin / 60) * jobMeta.pricePerHr;

  const files = probe.files;
  const wavMatch = files.match(/^\d+/m);
  const wavCached = wavMatch ? parseInt(wavMatch[0]) : 0;

  const ckptList = files
    .split('\n')
    .filter(l => l.includes('.safetensors'))
    .slice(0, 5);

  const lossLines = probe.loss.split('\n').filter(Boolean).slice(-10);

  return {
    instanceId: jobMeta.instanceId,
    gpuType: jobMeta.gpuType,
    provider: jobMeta.provider,
    pricePerHr: jobMeta.pricePerHr,
    elapsedMin,
    spent,
    stage,
    stageDetail: detail,
    gpuPct,
    vramUsedGb: vramUsed / 1024,
    vramTotalGb: vramTotal / 1024,
    wavCached,
    checkpoints: ckptList,
    recentLoss: lossLines,
  };
}

const DEFAULT_PROBE_PATHS: Required<ProbePathsSpec> = {
  wavDir: '/root/data/wav',
  dataPathsFile: '/root/data_paths.jsonl',
  encodedFile: '/root/encoded.pt',
  encodedFullFile: '/root/encoded_full.pt',
  checkpointsDir: '/workspace/checkpoints',
  smokeCheckpointsDir: '/workspace/smoke_ckpt',
  jobLog: '/workspace/.job.log',
};

/** SSH command template for one-shot remote probe. Paths configurable per preset. */
export function buildProbeCommand(paths: ProbePathsSpec = {}): string {
  const p = { ...DEFAULT_PROBE_PATHS, ...paths };
  return [
    `echo '${SEP}procs${SEP}';`,
    `ps -ef | grep -v grep | grep -E 'hf download|python distill|python -c' | head -3;`,
    `echo '${SEP}files${SEP}';`,
    `ls ${p.wavDir} 2>/dev/null | wc -l;`,
    `[ -f ${p.dataPathsFile} ] && wc -l ${p.dataPathsFile} 2>/dev/null;`,
    `[ -f ${p.encodedFile} ] && du -h ${p.encodedFile} 2>/dev/null;`,
    `[ -f ${p.encodedFullFile} ] && du -h ${p.encodedFullFile} 2>/dev/null;`,
    `ls ${p.checkpointsDir}/ 2>/dev/null | head -10;`,
    `ls ${p.smokeCheckpointsDir}/ 2>/dev/null | head -10;`,
    `echo '${SEP}loss${SEP}';`,
    `tail -100 ${p.jobLog} 2>/dev/null | grep -oE 'step=[0-9]+/[0-9]+|loss=[0-9.]+|rate=[0-9.]+|saved.*\\\\.safetensors|\\\\[smoke-verify\\\\]' | tail -10;`,
    `echo '${SEP}gpu${SEP}';`,
    `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1;`,
    `echo '${SEP}disk${SEP}';`,
    `df -h /workspace /root 2>/dev/null | head -5;`,
  ].join(' ');
}
