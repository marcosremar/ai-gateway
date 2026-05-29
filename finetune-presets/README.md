# Finetune Presets

A **preset** bundles the training algorithm for a model family so a user can
finetune with zero training code — just a `train.yaml` pointing at a dataset:

```yaml
type: flow-matching-tts        # = preset directory name
dataset: hf://you/your-data
hfBase: you/your-model
```

`ai-gateway gpu finetune submit -f train.yaml` then provisions a GPU, downloads
data + model, encodes, smoke-tests, trains, and pushes weights — driven entirely
by the preset.

## Scaffold a new preset

```bash
ai-gateway gpu finetune init my-model --type audio   # or --type text
#   → finetune-presets/my-model/{manifest.json,trainer.py,prepare_dataset.py}
ai-gateway gpu finetune validate --type my-model --dataset hf://you/data
ai-gateway gpu finetune submit   --type my-model --dataset hf://you/data --smoke
```

The scaffold emits a **valid, self-contained skeleton** that already speaks the
trainer contract below. Edit `trainer.py` (encode/train) and `prepare_dataset.py`
for your model, then `validate` (schema + lint) before spending on a GPU.

## Files

| File | Required | Purpose |
|------|----------|---------|
| `manifest.json` | ✅ | Declares the trainer interface, deps, defaults (schema below) |
| `trainer.py` | ✅ | Implements `encode` + `train` subcommands |
| `prepare_dataset.py` | optional | Normalizes raw `metadata.jsonl` → `data_paths.jsonl` (auto-run pre-encode) |
| `encode_multi_gpu.sh` | optional | Sharded multi-GPU encode (used when `numGpus > 1`) |

## Standard on-pod paths

The pipeline (`src/modules/gpu-finetune/run.ts`) wires these — your scripts must use them:

| Path | Stage |
|------|-------|
| `/root/data/metadata.jsonl` (or `train.jsonl`) | raw dataset input to `prepare_dataset.py` |
| `/root/data_paths.jsonl` | normalized rows → input to `encode` |
| `/root/encoded.pt` | encoded artifact → input to `train` |
| `/workspace/checkpoints/step-<N>.safetensors` | checkpoints (enables `--ckpt-avg` + resume) |

## Trainer contract

`trainer.py` must accept (extra auto-flags are appended by the pipeline — tolerate
them with `parse_known_args`):

```
encode  --input <data_paths.jsonl> --output <encoded.pt> [--num-workers N] [--max-samples N]
train   --tokens <encoded.pt> --output <ckpt_dir> --epochs N --learning-rate X
        --save-every-steps N [--resume <ckpt_dir>] [--torch-compile] [--auto-stop-plateau N] ...
```

- **Checkpoints**: save as `<out>/step-<N>.safetensors`.
- **Resume**: `--resume <dir>` warm-starts from the latest `step-*.safetensors` (save full
  state — model + optimizer + scheduler + step — so spot-preemption resume is exact).
- **HF push**: when `IARATTS_HF_WEIGHTS_REPO` is set, upload each checkpoint (non-fatal).
  `IARATTS_HF_DATASET_REPO` (encoded.pt) and `IARATTS_HF_CODE_REPO` (scripts) are also injected.
- **Self-calibration** (optional, recommended): print at the end of each stage —
  `[calib] steps_per_sec=<N>` (train) and `[calib] encode_rate_per_gpu=<N>` (encode).
  ai-gateway records these per (GPU, model-size, task, mode) so future auto-select
  cost estimates use your *measured* throughput instead of the built-in priors.
  The scaffold emits both automatically.

## manifest.json schema

```jsonc
{
  "name": "my-model",            // = directory name
  "version": "0.1.0",
  "description": "...",
  "type": "audio",               // audio | text | custom
  "trainerScript": "trainer.py",
  "prepareScript": "prepare_dataset.py",   // optional; auto-run before encode
  "defaultModel": "hf://owner/base",        // optional
  "defaultEpochs": 3, "defaultLR": 3e-5, "defaultGpu": "4090", "defaultMaxSpend": 3.0,
  "trainerInterface": {
    "encode": "python trainer.py encode --input /root/data_paths.jsonl --output /root/encoded.pt --num-workers 8",
    "train":  "python trainer.py train --tokens /root/encoded.pt --output /workspace/checkpoints --epochs N --learning-rate X --save-every-steps N"
  },
  "aptDeps": "", "pipDeps": "huggingface-hub hf_xet safetensors soundfile",
  "torchVersion": "", "torchCudaIndex": "",   // pin a torch wheel if the host CUDA needs it
  "defaultStepsPerSec": 3, "defaultEncodeRatePerGpu": 25,  // cost-estimator hints
  "smokeVerify":   { "pythonInline": "..." },  // optional: assert ckpt sanity after smoke
  "preSmokeVerify":{ "pythonInline": "..." },  // optional: 30-sample × 3-epoch pre-full check
  "probePaths": {                              // optional: override stage-detection paths
    "dataPathsFile": "/root/data_paths.jsonl",
    "encodedFile":   "/root/encoded.pt",
    "checkpointsDir":"/workspace/checkpoints"
  }
}
```

`validate` runs `lintPresetManifest()` (via `gpu finetune presets`) which flags
missing `trainerInterface.train`/`trainerScript` and **unknown `probePaths` keys**
(a typo there silently disables stage detection).

> **Note:** model downloads use `hf-xet` (`HF_XET_HIGH_PERFORMANCE=1`), never the
> deprecated `HF_HUB_ENABLE_HF_TRANSFER`. Pre-bake weights into your Docker image
> when possible — lazy runtime download loses ~24% on cold starts.

## Built-in presets

- **flow-matching-tts** — kyutai/pocket-tts flow-matching TTS (Mimi codec frozen, LSD loss)
- **codec-tts** — VUI/Fluac codec TTS via teacher-forcing cross-entropy
- **lora-llm** — LoRA/QLoRA instruction-tuning for 7B–32B LLMs
