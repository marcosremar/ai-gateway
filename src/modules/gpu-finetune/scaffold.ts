/**
 * Preset scaffolding — generate a new finetune preset skeleton.
 *
 * Adding a new model type today means hand-writing manifest.json + trainer.py
 * from scratch against an undocumented interface. `scaffoldPreset()` emits a
 * valid, self-contained skeleton that already speaks the trainer contract
 * run.ts expects (encode/train subcommands, standard paths, --resume,
 * step-*.safetensors checkpoints, optional HF push). Pure: returns the files to
 * write so the CLI layer owns disk I/O and it stays unit-testable.
 */

export type ScaffoldType = 'audio' | 'text';

export interface ScaffoldFile {
  /** Path relative to the preset directory. */
  rel: string;
  contents: string;
}

export interface ScaffoldOpts {
  type?: ScaffoldType;          // default 'audio'
  description?: string;
  defaultModel?: string;        // hf://owner/repo
}

/** Standard on-pod paths the pipeline (run.ts) wires. Keep in sync with run.ts. */
export const STD_PATHS = {
  dataPaths: '/root/data_paths.jsonl',
  metadata: '/root/data/metadata.jsonl',
  encoded: '/root/encoded.pt',
  checkpoints: '/workspace/checkpoints',
} as const;

function manifestJson(name: string, o: Required<ScaffoldOpts>): string {
  const manifest = {
    name,
    version: '0.1.0',
    description: o.description,
    type: o.type,
    trainerScript: 'trainer.py',
    prepareScript: 'prepare_dataset.py',
    ...(o.defaultModel ? { defaultModel: o.defaultModel } : {}),
    defaultEpochs: 3,
    defaultLR: 3e-5,
    defaultGpu: '4090',
    defaultMaxSpend: 3.0,
    trainerInterface: {
      encode: `python trainer.py encode --input ${STD_PATHS.dataPaths} --output ${STD_PATHS.encoded} --num-workers 8`,
      train: `python trainer.py train --tokens ${STD_PATHS.encoded} --output ${STD_PATHS.checkpoints} --epochs N --learning-rate X --save-every-steps N`,
    },
    aptDeps: '',
    pipDeps: 'huggingface-hub hf_xet safetensors soundfile',
    torchCudaIndex: '',
    torchVersion: '',
    // Cost-estimator hints — calibrate against a real run.
    defaultStepsPerSec: 3,
    defaultEncodeRatePerGpu: 25,
    probePaths: {
      dataPathsFile: STD_PATHS.dataPaths,
      encodedFile: STD_PATHS.encoded,
      checkpointsDir: STD_PATHS.checkpoints,
    },
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

function prepareScriptPy(): string {
  return `#!/usr/bin/env python3
"""Normalize raw dataset metadata -> data_paths.jsonl (one row per sample).

ai-gateway runs this automatically before encode (preset declares prepareScript)
against ${STD_PATHS.metadata}, writing ${STD_PATHS.dataPaths}.
Each output row should carry whatever your encode step needs (absolute paths).
"""
import argparse, json, os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="metadata.jsonl / train.jsonl")
    ap.add_argument("--output", required=True, help="data_paths.jsonl to write")
    ap.add_argument("--wav-root", default="", help="root to resolve relative audio paths")
    args = ap.parse_args()

    n = 0
    with open(args.input) as fin, open(args.output, "w") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            # TODO: adapt to your dataset schema. Example resolves an audio path.
            if "audio" in row and args.wav_root and not os.path.isabs(row["audio"]):
                row["audio"] = os.path.join(args.wav_root, row["audio"])
            fout.write(json.dumps(row) + "\\n")
            n += 1
    print(f"[prepare] wrote {n} rows -> {args.output}")


if __name__ == "__main__":
    main()
`;
}

function trainerPy(name: string): string {
  return `#!/usr/bin/env python3
"""Trainer skeleton for the '${name}' preset.

Implements the ai-gateway trainer contract (see finetune-presets/README.md):
  encode  --input <data_paths.jsonl> --output <encoded.pt> [--num-workers N]
  train   --tokens <encoded.pt> --output <ckpt_dir> --epochs N
          --learning-rate X --save-every-steps N [--resume <ckpt_dir>]

Conventions the pipeline relies on:
  - checkpoints saved as <out>/step-<N>.safetensors  (enables --ckpt-avg + resume)
  - --resume <dir> warm-starts from the latest step-*.safetensors in <dir>
  - extra auto-flags (--torch-compile, --auto-stop-plateau, --batch-size, ...)
    are tolerated via parse_known_args so the trainer never breaks on a new flag
  - HF push is automatic when IARATTS_HF_WEIGHTS_REPO is set
"""
import argparse, glob, json, os


def _hf_push(path: str, name_in_repo: str):
    """Upload a file to the HF weights repo if configured. Non-fatal."""
    repo = os.environ.get("IARATTS_HF_WEIGHTS_REPO") or os.environ.get("IARATTS_HF_PUSH_REPO")
    if not repo:
        return
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=os.environ.get("HF_TOKEN"))
        api.create_repo(repo_id=repo, repo_type="model", exist_ok=True, private=False)
        api.upload_file(path_or_fileobj=path, path_in_repo=name_in_repo,
                        repo_id=repo, repo_type="model")
        print(f"  ↑ pushed -> hf://{repo}/{name_in_repo}")
    except Exception as e:  # noqa: BLE001
        print(f"  ⚠ HF push failed (non-fatal): {e}")


def _latest_ckpt(out: str):
    ckpts = sorted(glob.glob(os.path.join(out, "step-*.safetensors")),
                   key=lambda p: int(p.rsplit("step-", 1)[1].rsplit(".", 1)[0]))
    return ckpts[-1] if ckpts else None


def encode(args):
    import time
    rows = [json.loads(l) for l in open(args.input) if l.strip()]
    if args.max_samples:
        rows = rows[: args.max_samples]
    t0 = time.time()
    # TODO: turn each row into model inputs (tokens/latents) and persist to args.output.
    import torch
    torch.save({"rows": rows}, args.output)
    dt = max(1e-6, time.time() - t0)
    print(f"[encode] wrote {len(rows)} samples -> {args.output}")
    # Self-calibration: ai-gateway records this to refine future cost estimates.
    print(f"[calib] encode_rate_per_gpu={len(rows) / dt:.2f}")


def train(args):
    import time
    import torch
    from safetensors.torch import save_file
    os.makedirs(args.output, exist_ok=True)

    start_step = 0
    if args.resume:
        last = _latest_ckpt(args.resume)
        if last:
            start_step = int(last.rsplit("step-", 1)[1].rsplit(".", 1)[0])
            print(f"[train] resuming from {last} (step {start_step})")
            # TODO: load_file(last) into your model/optimizer/scheduler.

    data = torch.load(args.tokens)
    rows = data.get("rows", [])
    print(f"[train] {len(rows)} samples, {args.epochs} epochs, lr={args.learning_rate}")

    # TODO: replace this stub loop with a real training step.
    step = start_step
    total = max(1, len(rows)) * args.epochs
    t0 = time.time()
    while step < start_step + total:
        step += 1
        if step % args.save_every_steps == 0 or step >= start_step + total:
            path = os.path.join(args.output, f"step-{step}.safetensors")
            save_file({"placeholder": torch.zeros(1)}, path)  # TODO: real state_dict
            print(f"[save] step={step} -> {path}")
            _hf_push(path, os.path.basename(path))
    dt = max(1e-6, time.time() - t0)
    # Self-calibration: ai-gateway records this to refine future cost estimates.
    print(f"[calib] steps_per_sec={(step - start_step) / dt:.3f}")
    print("[train] done")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("encode")
    e.add_argument("--input", required=True)
    e.add_argument("--output", required=True)
    e.add_argument("--num-workers", type=int, default=8)
    e.add_argument("--max-samples", type=int, default=0)

    t = sub.add_parser("train")
    t.add_argument("--tokens", required=True)
    t.add_argument("--output", required=True)
    t.add_argument("--epochs", type=int, default=3)
    t.add_argument("--learning-rate", type=float, default=3e-5)
    t.add_argument("--save-every-steps", type=int, default=100)
    t.add_argument("--resume", default=None)

    # Tolerate extra auto-flags the pipeline appends (--torch-compile, etc.).
    args, _unknown = p.parse_known_args()
    {"encode": encode, "train": train}[args.cmd](args)
`;
}

/**
 * Generate the file set for a new preset. Caller writes each {rel, contents}
 * under finetune-presets/<name>/.
 */
export function scaffoldPreset(name: string, opts: ScaffoldOpts = {}): ScaffoldFile[] {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid preset name '${name}' — use lowercase kebab-case (a-z0-9-)`);
  }
  const resolved: Required<ScaffoldOpts> = {
    type: opts.type ?? 'audio',
    description: opts.description ?? `${name} finetune preset (scaffolded — edit before use)`,
    defaultModel: opts.defaultModel ?? '',
  };
  return [
    { rel: 'manifest.json', contents: manifestJson(name, resolved) },
    { rel: 'trainer.py', contents: trainerPy(name) },
    { rel: 'prepare_dataset.py', contents: prepareScriptPy() },
  ];
}
