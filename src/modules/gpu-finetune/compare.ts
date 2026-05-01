/**
 * Finetune A/B comparison via WER (Word Error Rate).
 * Generates audio from multiple checkpoints for the same prompts,
 * transcribes with Whisper, computes WER, ranks checkpoints.
 */

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface CompareOpts {
  ckpts: string[];
  prompts: string;
  max?: number;
  whisperModel?: string;
  /** Override script path (for tests). Default: /tmp/finetune_compare.py */
  scriptPath?: string;
  /** Override python binary. Default: python3 */
  python?: string;
  /** Echo child stdout while capturing. Default: true */
  echo?: boolean;
}

export interface CompareRow {
  avg: number;
  plain: number;
  tagged: number;
  n: number;
}

export interface CompareResult {
  winner: string;
  winnerAvgWer: number;
  results: Record<string, CompareRow>;
}

const RESULT_LINE = /^(\S+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$/;
const WINNER_LINE = /^WINNER:\s+(\S+)\s+\(avg=([\d.]+)\)/;

/** Parse stdout of the compare python script into a structured result. */
export function parseCompareOutput(out: string): CompareResult {
  const results: Record<string, CompareRow> = {};
  let winner = '';
  let winnerAvgWer = 0;
  let inTable = false;

  for (const ln of out.split('\n')) {
    if (/^ckpt\s+n\s+avg\s+plain\s+tagged/.test(ln)) { inTable = true; continue; }
    if (inTable) {
      const m = ln.match(RESULT_LINE);
      if (m) {
        results[m[1]] = {
          n: parseInt(m[2], 10),
          avg: parseFloat(m[3]),
          plain: parseFloat(m[4]),
          tagged: parseFloat(m[5]),
        };
        continue;
      }
      if (ln.trim() === '') inTable = false;
    }
    const w = ln.match(WINNER_LINE);
    if (w) { winner = w[1]; winnerAvgWer = parseFloat(w[2]); }
  }

  return { winner, winnerAvgWer, results };
}

function buildCompareScript(opts: CompareOpts): string {
  const ckpts = JSON.stringify(opts.ckpts);
  const max = opts.max ?? 60;
  const model = opts.whisperModel || 'base';
  return `
import sys, json, os
from pathlib import Path
import whisper
sys.path.insert(0, str(Path('${opts.prompts}').parent.parent / 'distill'))
try:
    from eval_finetune import wer
except ImportError:
    def wer(ref, hyp):
        from rapidfuzz.distance import Levenshtein
        ref_words = ref.split()
        hyp_words = hyp.split()
        dist = Levenshtein.distance(ref_words, hyp_words)
        return dist / max(len(ref_words), 1)

prompts = json.load(open('${opts.prompts}'))[:${max}]
print(f'loading whisper-${model}...')
w = whisper.load_model('${model}')
results = {}
for ckpt in ${ckpts}:
    name = os.path.basename(ckpt).replace('.safetensors', '')
    out_dir = f'/tmp/cmp_{name}'
    os.makedirs(out_dir, exist_ok=True)
    if len(os.listdir(out_dir)) < len(prompts):
        os.system(f"python -c \\"import sys; sys.argv=['','-c','{ckpt}','-p','${opts.prompts}','-o','{out_dir}','--no-asr','--max','${max}']; from eval_finetune import main; main()\\"")
    wers, plain, tagged = [], [], []
    for p in prompts:
        wav = f'{out_dir}/{p["id"]}.wav'
        if not os.path.exists(wav): continue
        e = wer(p['text'], w.transcribe(wav, language='pt')['text'])
        wers.append(e)
        (tagged if p.get('tag_positions') else plain).append(e)
    results[name] = {
        'avg': sum(wers)/max(len(wers),1),
        'plain': sum(plain)/max(len(plain),1),
        'tagged': sum(tagged)/max(len(tagged),1),
        'n': len(wers),
    }
print()
print(f'{"ckpt":40s} {"n":>5s} {"avg":>6s} {"plain":>7s} {"tagged":>7s}')
for name, r in sorted(results.items(), key=lambda kv: kv[1]['avg']):
    print(f'{name:40s} {r["n"]:>5d} {r["avg"]:>6.3f} {r["plain"]:>7.3f}  {r["tagged"]:>7.3f}')
print()
winner = min(results.items(), key=lambda kv: kv[1]['avg'])
print(f'WINNER: {winner[0]} (avg={winner[1]["avg"]:.3f})')
`;
}

/** Run WER A/B comparison. Returns ranked results parsed from script output. */
export function runCompare(opts: CompareOpts): CompareResult {
  const tmpScript = opts.scriptPath || '/tmp/finetune_compare.py';
  writeFileSync(tmpScript, buildCompareScript(opts));
  const python = opts.python || 'python3';
  const echo = opts.echo !== false;

  const r = spawnSync(python, [tmpScript], { encoding: 'utf-8' });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  if (echo) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  if (r.status !== 0 && r.status !== null) {
    throw new Error(`compare script exited with code ${r.status}: ${stderr.slice(-200)}`);
  }
  return parseCompareOutput(stdout);
}
