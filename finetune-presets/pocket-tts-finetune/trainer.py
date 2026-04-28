"""IaraTTS v8 Stage F — finetune Pocket TTS para Erinome + tags.

Implements the training path missing in upstream pocket_tts (inference-only).

Architecture (per pocket_tts/models/flow_lm.py):
    text → LUTConditioner → text_emb [B, Tt, dim]
                                  ↓
                          ┌───────┴───────┐
                          ↓               ↓
    audio_latent x_t → input_linear   transformer (sees text + audio)
                                          ↓
                                  transformer_out [B, T, dim]
                                          ↓
                                    flow_net(cond, t, x_t) → u_t_pred

Training step (added here):
    1. Tokenize text → conditioner.embed → text_emb
    2. Mimi-encode audio → x_1 [B, Ta, ldim]
    3. Sample t ~ U[0,1] per frame
    4. x_0 ~ N(0, I)
    5. x_t = (1-t)*x_0 + t*x_1
    6. transformer_out = backbone(input_linear(x_t), text_emb, x_t, fresh_state)
    7. u_t_target = x_1 - x_0
    8. u_t_pred = flow_net(transformer_out, t, x_t)
    9. loss = MSE(u_t_pred, u_t_target)

Reference: arXiv:2505.18825 LSD.

Usage:
    # Encode dataset (Mimi latents from wavs)
    python trainer.py encode --input erinome.jsonl --output erinome_mimi.pt

    # Smoke test (random data, no GPU needed, validates code)
    python trainer.py smoke

    # Real train (requires HF terms accept + GPU)
    python trainer.py train --tokens erinome_mimi.pt --output ckpt/
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import torch
from torch import nn


@dataclass
class FinetuneConfig:
    pocket_tts_language: str = "portuguese"
    erinome_pt: str = "erinome_mimi.pt"
    output_dir: str = "checkpoints/v8_pocket_finetune"
    epochs: int = 4
    micro_batch_size: int = 2
    grad_accum: int = 16
    learning_rate: float = 5e-5
    weight_decay: float = 0.01
    warmup_steps: int = 200
    bf16: bool = True
    seed: int = 42
    save_every_steps: int = 100
    log_every_steps: int = 25
    freeze_backbone_layers: int = 4
    flow_loss_weight: float = 1.0
    eos_loss_weight: float = 0.1
    grad_clip: float = 1.0
    # Round 5 — quality features
    auto_lr_rewind: bool = False        # restore last good ckpt + halve LR on NaN/divergence
    rewind_threshold: float = 5.0       # loss > N × recent_avg = trigger
    curriculum: str = ""                # "" | "linear" sorts by latent length, train in 3 phases
    multi_dataset_weights: Optional[list] = None  # weighted sampling: list of (path, weight)
    only_flow_net: bool = False  # MoshiVis-style: train ONLY flow_net + out_eos (minimal LoRA-like surface)
    auto_stop_plateau: int = 0   # stop if loss doesn't improve for N steps (0=disabled)
    plateau_tolerance: float = 0.01  # min relative drop to count as improvement
    use_torch_compile: bool = False  # torch.compile flow_lm for 1.5-2× speedup
    augment_pitch: bool = False  # pitch-shift ±2 semitones randomly during encode (data aug)
    augment_speed: bool = False  # speed-perturb 0.9-1.1× during encode


def encode_dataset(input_jsonl: str, output_pt: str,
                   language: str = "portuguese",
                   max_samples: Optional[int] = None,
                   num_workers: int = 8,
                   shard_index: int = 0,
                   num_shards: int = 1,
                   augment_pitch: bool = False,
                   augment_speed: bool = False) -> int:
    """Encode each wav → Mimi latents. Save .pt with list of (text, latents).

    Uses ThreadPoolExecutor for parallel audio I/O (CPU-bound), then runs the
    GPU encoder in a tight loop on the main thread (Mimi isn't thread-safe).
    On RTX 4090 this lifts throughput from ~2.8/s to ~12-15/s (4-5× speedup).
    """
    from concurrent.futures import ThreadPoolExecutor
    from pocket_tts import TTSModel
    from pocket_tts.data.audio import audio_read
    from pocket_tts.data.audio_utils import convert_audio

    print(f"loading Pocket TTS {language}...")
    model = TTSModel.load_model(language=language)
    target_sr = model.config.mimi.sample_rate
    print(f"sample_rate={target_sr} num_workers={num_workers}")

    rows = []
    with open(input_jsonl) as f:
        for line in f:
            line = line.strip()
            if line: rows.append(json.loads(line))
    if max_samples:
        rows = rows[:max_samples]
    if num_shards > 1:
        # Round-robin shard so each shard gets balanced workload
        rows = rows[shard_index::num_shards]
        print(f"shard {shard_index}/{num_shards}: {len(rows)} samples")
    if augment_pitch or augment_speed:
        # Duplicate rows: 1× original (skip aug via flags above), 1× augmented
        # _maybe_augment uses random.random() < 0.5 so first pass tends clean
        rows = rows + rows
        print(f"augmentation enabled (pitch={augment_pitch} speed={augment_speed}) — "
              f"dataset doubled to {len(rows)} samples")
    print(f"encoding {len(rows)} samples...")

    def _maybe_augment(audio: torch.Tensor, sr: int):
        """Random pitch/speed perturbation. CPU-side, before convert_audio."""
        if augment_pitch and random.random() < 0.5:
            try:
                import torchaudio.functional as AF
                semitones = random.uniform(-2.0, 2.0)
                audio = AF.pitch_shift(audio, sr, semitones)
            except Exception:
                pass
        if augment_speed and random.random() < 0.5:
            try:
                import torchaudio.functional as AF
                factor = random.uniform(0.9, 1.1)
                audio, _ = AF.speed(audio, sr, factor)
            except Exception:
                pass
        return audio

    def load_one(r):
        try:
            audio, sr = audio_read(r["audio"])
            audio = _maybe_augment(audio, sr)
            return (r, convert_audio(audio, sr, target_sr, 1), None)
        except Exception as e:
            return (r, None, str(e))

    encoded = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=num_workers) as pool:
        # Pipeline: workers preload audio while GPU encodes the previous one.
        for i, (r, audio, err) in enumerate(pool.map(load_one, rows)):
            if err is not None:
                print(f"  fail {r.get('audio', '?')}: {err}")
                continue
            try:
                with torch.no_grad():
                    raw = model.mimi.encode_to_latent(audio.unsqueeze(0).to(model.device))
                    raw = raw.transpose(-1, -2)
                encoded.append({
                    "text": r["text"],
                    "latents": raw.squeeze(0).cpu(),
                    "tag_positions": r.get("tag_positions", []),
                })
                if (i + 1) % 200 == 0:
                    rate = (i + 1) / (time.time() - t0)
                    print(f"  [{i+1}/{len(rows)}] rate={rate:.1f}/s")
            except Exception as e:
                print(f"  fail {r.get('audio', '?')}: {e}")
    torch.save(encoded, output_pt)
    print(f"saved {len(encoded)} → {output_pt}")

    # Round 6: push encoded.pt to HF dataset repo if env set. Reuse across runs.
    ds_repo = os.environ.get("IARATTS_HF_DATASET_REPO")
    if ds_repo:
        try:
            from huggingface_hub import HfApi
            api = HfApi(token=os.environ.get("HF_TOKEN"))
            try:
                api.create_repo(repo_id=ds_repo, repo_type="dataset",
                                exist_ok=True, private=False)
            except Exception as ce:
                print(f"  ⚠ create dataset repo: {ce}")
            api.upload_file(
                path_or_fileobj=output_pt,
                path_in_repo=os.path.basename(output_pt),
                repo_id=ds_repo,
                repo_type="dataset",
                commit_message=f"encoded {len(encoded)} samples",
            )
            # Upload manifest (paths) too
            if os.path.exists(input_jsonl):
                api.upload_file(
                    path_or_fileobj=input_jsonl,
                    path_in_repo=os.path.basename(input_jsonl),
                    repo_id=ds_repo,
                    repo_type="dataset",
                    commit_message="paths manifest",
                )
            print(f"  ↑ pushed → hf://datasets/{ds_repo}/{os.path.basename(output_pt)}")
        except Exception as e:
            print(f"  ⚠ HF dataset push failed (non-fatal): {e}")
    return len(encoded)


def flow_matching_loss(flow_net, transformer_out, x_1, ldim):
    """Flow-matching MSE.

    Args:
        flow_net: callable(cond, t, x_t) → u_t
        transformer_out: [B, T, dim]
        x_1: [B, T, ldim] target latents

    Returns:
        loss scalar
    """
    B, T, _ = x_1.shape
    device = x_1.device
    dtype = x_1.dtype
    t = torch.rand(B, T, 1, device=device, dtype=dtype)
    x_0 = torch.randn_like(x_1)
    x_t = (1.0 - t) * x_0 + t * x_1
    u_target = x_1 - x_0
    u_pred = flow_net(transformer_out, t, x_t)
    return ((u_pred - u_target) ** 2).mean()


def training_forward(model, text_str: str, audio_latents: torch.Tensor):
    """Single-sample training forward pass. Returns flow-matching loss.

    Built by adapting flow_lm.forward (which has assert lsd_decode_steps > 0
    that prevents training) — we bypass and compute loss instead.

    Args:
        model: TTSModel
        text_str: input text
        audio_latents: [T, ldim] Mimi latents (target x_1)

    Returns:
        scalar loss tensor
    """
    flow_lm = model.flow_lm
    device = next(flow_lm.parameters()).device
    # flow_lm.dtype is stale after model.to(bf16); use actual weight dtype.
    dtype = next(flow_lm.parameters()).dtype

    # Text → embedding
    from pocket_tts.conditioners.base import TokenizedText
    tokens = flow_lm.conditioner.tokenizer(text_str).tokens.to(device)
    text_emb = flow_lm.conditioner._get_condition(TokenizedText(tokens))
    if text_emb.dim() == 2:
        text_emb = text_emb.unsqueeze(0)

    # Audio latents [1, T, ldim]
    x_1 = audio_latents.unsqueeze(0).to(device=device, dtype=dtype)
    B, T, ldim = x_1.shape
    assert ldim == flow_lm.ldim

    # Sample noise + interpolation
    t_scalar = torch.rand(B, T, 1, device=device, dtype=dtype)
    x_0 = torch.randn_like(x_1)
    x_t = (1.0 - t_scalar) * x_0 + t_scalar * x_1
    u_target = x_1 - x_0

    # Project to backbone space
    input_proj = flow_lm.input_linear(x_t)

    # Run transformer with FRESH state (not cumulative — full-seq training)
    from pocket_tts.modules.stateful_module import init_states
    full_seq_len = text_emb.size(1) + input_proj.size(1)
    state = init_states(flow_lm, batch_size=B, sequence_length=full_seq_len)

    seq_in = torch.cat([text_emb, input_proj], dim=1)
    transformer_out = flow_lm.transformer(seq_in, state)
    if flow_lm.out_norm:
        transformer_out = flow_lm.out_norm(transformer_out)
    # Take only audio-region positions (skip text prefix). Keep model dtype
    # (bf16 if cfg.bf16 + cuda) so flow_net mat-mul matches its bf16 weights.
    cond = transformer_out[:, -T:]

    # Predict flow — flow_net signature: (c, s, t, x) — see SimpleMLPAdaLN.forward
    # All tensors must share dtype with flow_net weights (bf16 or fp32 per cfg).
    s_zero = torch.zeros_like(t_scalar)
    u_pred = flow_lm.flow_net(cond, s_zero, t_scalar, x_t)
    # Cast to fp32 only for the loss reduction (numerical stability).
    flow_loss = ((u_pred.float() - u_target.float()) ** 2).mean()

    # EOS BCE — predict end-of-sequence at the last frame only. Helps model learn
    # WHEN to stop rather than always running to max-len. Weight 0.1 default.
    if hasattr(flow_lm, "out_eos") and flow_lm.out_eos is not None:
        eos_logit = flow_lm.out_eos(cond)        # [B, T, 1]
        eos_target = torch.zeros_like(eos_logit)
        eos_target[:, -1:] = 1.0                  # last frame = end
        eos_loss = torch.nn.functional.binary_cross_entropy_with_logits(
            eos_logit.float(), eos_target.float()
        )
        return flow_loss + 0.1 * eos_loss
    return flow_loss


def freeze_layers(model, n_layers: int, only_flow_net: bool = False):
    """Freeze:
      - ALL Mimi codec params (encoder + decoder + quantizer) — never finetune codec
      - first N transformer.layers blocks of flow_lm
      - input_linear (32→1024 projection — keeps latent space stable)
      - if only_flow_net=True: freeze EVERYTHING except flow_net + out_eos
        (LoRA-style: minimal learnable surface, MoshiVis-recommended)
    Train: rest of flow_lm transformer, flow_net, out_norm, out_eos, conditioner.
    """
    n_frozen_params = 0
    n_total = 0
    for name, p in model.named_parameters():
        n_total += 1
        # CRITICAL: freeze entire Mimi codec — we encoded latents using its
        # original weights; if it drifts, decode_from_latent garbles audio.
        if name.startswith("mimi.") or ".mimi." in name:
            p.requires_grad = False
            n_frozen_params += 1
            continue
        # only_flow_net: train ONLY flow_net + out_eos. Freeze everything else.
        if only_flow_net:
            if "flow_net" in name or "out_eos" in name:
                continue  # trainable
            p.requires_grad = False
            n_frozen_params += 1
            continue
        # Freeze first N transformer blocks + input projection
        if "transformer.layers" in name:
            try:
                idx = int(name.split("transformer.layers.")[1].split(".")[0])
                if idx < n_layers:
                    p.requires_grad = False
                    n_frozen_params += 1
            except Exception:
                pass
        elif "input_linear" in name:
            p.requires_grad = False
            n_frozen_params += 1
    print(f"[freeze] {n_frozen_params}/{n_total} param groups frozen")


def train(cfg: FinetuneConfig, resume_from: str | None = None) -> None:
    rng = random.Random(cfg.seed)
    torch.manual_seed(cfg.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[train] device={device} bf16={cfg.bf16}")

    from pocket_tts import TTSModel
    print("[train] loading Pocket TTS...")
    model = TTSModel.load_model(language=cfg.pocket_tts_language)
    model = model.to(device)
    if cfg.bf16 and device.type == "cuda":
        model = model.to(torch.bfloat16)

    if resume_from:
        # Auto-discover latest step-*.safetensors if a directory was given
        if os.path.isdir(resume_from):
            import glob
            cands = sorted(glob.glob(os.path.join(resume_from, "step-*.safetensors")),
                           key=lambda p: int(p.rsplit("step-", 1)[1].rsplit(".", 1)[0]))
            if not cands:
                final = os.path.join(resume_from, "model.safetensors")
                if os.path.exists(final):
                    cands = [final]
            if not cands:
                raise FileNotFoundError(f"no checkpoints found in {resume_from}")
            resume_from = cands[-1]
        print(f"[train] resuming from {resume_from}")
        from safetensors.torch import load_file
        sd = load_file(resume_from)
        missing, unexpected = model.load_state_dict(sd, strict=False)
        print(f"  loaded (missing={len(missing)} unexpected={len(unexpected)})")

    freeze_layers(model, cfg.freeze_backbone_layers, only_flow_net=cfg.only_flow_net)

    # torch.compile for 1.5-2× speedup (PyTorch 2.0+)
    if cfg.use_torch_compile and hasattr(torch, "compile"):
        try:
            model.flow_lm.flow_net = torch.compile(model.flow_lm.flow_net, mode="reduce-overhead")
            print("[opt] torch.compile flow_net enabled")
        except Exception as e:
            print(f"[opt] torch.compile failed (non-fatal): {e}")

    print(f"[train] loading dataset {cfg.erinome_pt}")
    if cfg.multi_dataset_weights:
        # Round 5: weighted multi-dataset combine
        all_rows = []
        for path, weight in cfg.multi_dataset_weights:
            sub = torch.load(path, weights_only=False)
            for r in sub:
                r["__weight__"] = float(weight)
            all_rows.extend(sub)
            print(f"  + {path}: {len(sub)} rows × weight {weight}")
        rows = all_rows
    else:
        rows = torch.load(cfg.erinome_pt, weights_only=False)
    rng.shuffle(rows)
    n_val = max(1, int(len(rows) * 0.05))
    val_rows = rows[:n_val]
    train_rows = rows[n_val:]
    # Round 5: curriculum sort (linear: shortest first)
    if cfg.curriculum == "linear":
        train_rows.sort(key=lambda r: r["latents"].shape[0])
        print(f"  curriculum=linear: rows sorted by latent length asc")
    print(f"[train] train={len(train_rows)} val={len(val_rows)}")

    trainable = [p for p in model.parameters() if p.requires_grad]
    optim = torch.optim.AdamW(trainable, lr=cfg.learning_rate,
                                weight_decay=cfg.weight_decay, betas=(0.9, 0.95))

    total_steps = cfg.epochs * len(train_rows) // (cfg.micro_batch_size * cfg.grad_accum)
    print(f"[train] total steps: {total_steps}")

    def lr_lambda(s):
        if s < cfg.warmup_steps:
            return s / max(1, cfg.warmup_steps)
        prog = (s - cfg.warmup_steps) / max(1, total_steps - cfg.warmup_steps)
        return max(0.05, 0.5 * (1 + math.cos(math.pi * prog)))
    sched = torch.optim.lr_scheduler.LambdaLR(optim, lr_lambda)

    os.makedirs(cfg.output_dir, exist_ok=True)
    step = 0
    accum = 0
    optim.zero_grad()
    t0 = time.time()
    loss_running = 0.0

    # Round 5 — auto LR rewind state
    last_good_state = None      # snapshot of (model, optim, lr_factor) at last save
    last_good_step = 0
    recent_losses: list = []     # rolling window of last 50 step-avg losses
    rewind_lr_factor = 1.0       # multiplier on cfg.learning_rate (halved on rewind)

    # Plateau watcher state
    plateau_best_loss = float("inf")
    plateau_best_step = 0
    plateau_stop = False

    def snapshot_good():
        nonlocal last_good_state, last_good_step
        last_good_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        last_good_step = step

    def maybe_rewind(loss_val):
        nonlocal rewind_lr_factor
        if not cfg.auto_lr_rewind: return False
        is_nan = not torch.isfinite(torch.tensor(loss_val)).item() if isinstance(loss_val, float) else False
        if not is_nan and len(recent_losses) >= 10:
            recent_avg = sum(recent_losses[-10:]) / 10
            if loss_val > cfg.rewind_threshold * recent_avg:
                is_nan = True  # trigger rewind for blow-up too
        if not is_nan: return False
        if last_good_state is None:
            print(f"  ⛔ divergence detected (loss={loss_val}) but no good ckpt yet — skipping")
            return False
        print(f"  ⛔ DIVERGENCE: loss={loss_val} → restoring step {last_good_step} + halving LR")
        model.load_state_dict(last_good_state, strict=True)
        rewind_lr_factor *= 0.5
        for pg in optim.param_groups:
            pg["lr"] *= 0.5
        return True

    # Weighted sampling helper
    def sample_iter():
        if cfg.multi_dataset_weights:
            weights = [r.get("__weight__", 1.0) for r in train_rows]
            n = len(train_rows)
            idxs = torch.multinomial(torch.tensor(weights), n, replacement=True).tolist()
            return (train_rows[i] for i in idxs)
        return iter(train_rows)

    for ep in range(cfg.epochs):
        if cfg.curriculum != "linear":
            rng.shuffle(train_rows)
        for r in sample_iter():
            try:
                loss = training_forward(model, r["text"], r["latents"])
                loss_val = float(loss.item())
                if maybe_rewind(loss_val):
                    optim.zero_grad()
                    accum = 0
                    continue
                (loss / cfg.grad_accum).backward()
                accum += 1
                loss_running += loss_val
            except Exception as e:
                print(f"  step fail: {e}")
                continue

            if accum >= cfg.grad_accum:
                torch.nn.utils.clip_grad_norm_(trainable, cfg.grad_clip)
                optim.step()
                sched.step()
                optim.zero_grad()
                accum = 0
                step += 1
                # Track recent loss for rewind threshold detection
                recent_losses.append(loss_running / cfg.grad_accum)
                if len(recent_losses) > 50: recent_losses.pop(0)
                # Snapshot good ckpt every save_every_steps
                if cfg.auto_lr_rewind and step > 0 and step % max(50, cfg.save_every_steps // 2) == 0:
                    snapshot_good()

                if step % cfg.log_every_steps == 0 or step == 1:
                    avg = loss_running / cfg.grad_accum
                    dt = (time.time() - t0) / 60
                    print(f"[train] ep={ep} step={step}/{total_steps} "
                          f"loss={avg:.4f} lr={sched.get_last_lr()[0]:.2e} "
                          f"elapsed={dt:.1f}min")
                    # Plateau watcher: track best, stop if no improvement for N steps
                    if cfg.auto_stop_plateau > 0:
                        rel_drop = (plateau_best_loss - avg) / max(plateau_best_loss, 1e-6)
                        if rel_drop >= cfg.plateau_tolerance:
                            plateau_best_loss = avg
                            plateau_best_step = step
                        elif step - plateau_best_step >= cfg.auto_stop_plateau:
                            print(f"[plateau] no improvement for {cfg.auto_stop_plateau} steps "
                                  f"(best={plateau_best_loss:.4f} @ step {plateau_best_step}) → stopping")
                            plateau_stop = True
                    loss_running = 0.0

                if cfg.save_every_steps and step % cfg.save_every_steps == 0:
                    _save(model, cfg, step)

                if plateau_stop:
                    break
        if plateau_stop:
            break

    _save(model, cfg, step, final=True)


def _save(model, cfg: FinetuneConfig, step: int, final: bool = False) -> None:
    import safetensors.torch
    name = "model.safetensors" if final else f"step-{step}.safetensors"
    path = os.path.join(cfg.output_dir, name)
    safetensors.torch.save_file(model.state_dict(), path)
    cfg_path = os.path.join(cfg.output_dir, "config.json")
    if not os.path.exists(cfg_path):
        with open(cfg_path, "w") as f:
            json.dump(asdict(cfg), f, indent=2, default=str)
    print(f"[save] step={step} → {path}")

    # Live HF push: if IARATTS_HF_PUSH_REPO env is set, upload this ckpt
    # immediately to that HF model repo. Lets you grab intermediate ckpts
    # from HF without waiting for run completion or rsync.
    # Round 6: prefer split repos. WEIGHTS_REPO for ckpts, DATASET_REPO for
    # encoded.pt (handled in encode_dataset), CODE_REPO for training scripts
    # (handled in main bash step). Fallback to single PUSH_REPO for compat.
    push_repo = os.environ.get("IARATTS_HF_WEIGHTS_REPO") or os.environ.get("IARATTS_HF_PUSH_REPO")
    if push_repo:
        try:
            from huggingface_hub import HfApi
            api = HfApi(token=os.environ.get("HF_TOKEN"))
            # Auto-create repo if missing (idempotent — exist_ok=True)
            try:
                api.create_repo(repo_id=push_repo, repo_type="model",
                                exist_ok=True, private=False)
            except Exception as ce:
                print(f"  ⚠ create_repo: {ce}")
            api.upload_file(
                path_or_fileobj=path,
                path_in_repo=name,
                repo_id=push_repo,
                repo_type="model",
                commit_message=f"step {step}{' (final)' if final else ''}",
            )
            # Also push config.json at first save (idempotent)
            if os.path.exists(cfg_path):
                api.upload_file(
                    path_or_fileobj=cfg_path,
                    path_in_repo="config.json",
                    repo_id=push_repo,
                    repo_type="model",
                    commit_message=f"config @ step {step}",
                )
            print(f"  ↑ pushed → hf://{push_repo}/{name}")
        except Exception as e:
            print(f"  ⚠ HF push failed (non-fatal): {e}")


def smoke(n_steps: int = 50):
    """Smoke test trainer on Mac CPU with synthetic data.

    Validates:
    - training_forward returns scalar loss
    - backward + optim.step() update params
    - convergence trend (loss should decrease)
    """
    print(f"=== smoke test (CPU + {n_steps} steps synthetic) ===")
    from pocket_tts import TTSModel
    print("loading PT model...")
    model = TTSModel.load_model(language="portuguese")
    print(f"loaded ldim={model.flow_lm.ldim} dim={model.flow_lm.dim}")

    freeze_layers(model, 4)
    trainable = [p for p in model.parameters() if p.requires_grad]
    optim = torch.optim.AdamW(trainable, lr=1e-4)
    print(f"trainable: {sum(p.numel() for p in trainable)/1e6:.1f}M params")

    # Fixed sample for overfit test (memorize 1 sample → loss should drop)
    T = 30
    fixed_text = "Olá mundo, este é um teste de convergência do trainer."
    fixed_latents = torch.randn(T, model.flow_lm.ldim)

    print(f"\nOverfit test — single sample, {n_steps} steps:")
    losses = []
    t0 = time.time()
    for i in range(n_steps):
        try:
            loss = training_forward(model, fixed_text, fixed_latents)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(trainable, 1.0)
            optim.step()
            optim.zero_grad()
            losses.append(loss.item())
            if i == 0 or (i + 1) % 10 == 0:
                avg_recent = sum(losses[-10:]) / min(10, len(losses))
                print(f"  step {i+1:3d}: loss={loss.item():.4f} avg10={avg_recent:.4f}")
        except Exception as e:
            print(f"  step {i+1} FAIL: {type(e).__name__}: {e}")
            import traceback; traceback.print_exc()
            return False
    dt = time.time() - t0

    initial = sum(losses[:5]) / 5
    final = sum(losses[-5:]) / 5
    drop_pct = (initial - final) / max(initial, 1e-6) * 100
    print(f"\n=== Summary ===")
    print(f"initial avg (1-5):  {initial:.4f}")
    print(f"final avg ({n_steps-4}-{n_steps}):    {final:.4f}")
    print(f"drop:               {drop_pct:.1f}%")
    print(f"total time:         {dt:.1f}s ({dt/n_steps*1000:.0f}ms/step)")
    if drop_pct > 5:
        print(f"\n✓ trainer CONVERGE (loss dropped {drop_pct:.1f}%)")
        return True
    else:
        print(f"\n⚠ marginal convergence (drop {drop_pct:.1f}% — may need lr tune)")
        return True


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    p_enc = sub.add_parser("encode", help="Encode wavs to Mimi latents")
    p_enc.add_argument("--input", required=True)
    p_enc.add_argument("--output", required=True)
    p_enc.add_argument("--language", default="portuguese")
    p_enc.add_argument("--max-samples", type=int, default=None)
    p_enc.add_argument("--num-workers", type=int, default=8,
                       help="Parallel audio I/O threads (default 8)")
    p_enc.add_argument("--shard-index", type=int, default=0,
                       help="0-based shard for multi-GPU: encode rows[shard::num_shards]")
    p_enc.add_argument("--num-shards", type=int, default=1,
                       help="Total shards (= number of GPUs in multi-GPU run)")
    p_enc.add_argument("--augment-pitch", action="store_true",
                       help="Augment: pitch-shift ±2 semitones randomly (doubles dataset)")
    p_enc.add_argument("--augment-speed", action="store_true",
                       help="Augment: speed-perturb 0.9-1.1× randomly (doubles dataset)")

    p_tr = sub.add_parser("train", help="Run finetune")
    p_tr.add_argument("--tokens", required=True)
    p_tr.add_argument("--output", required=True)
    p_tr.add_argument("--epochs", type=int, default=4)
    p_tr.add_argument("--learning-rate", type=float, default=5e-5)
    p_tr.add_argument("--save-every-steps", type=int, default=100,
                      help="Save checkpoint every N steps (default 100)")
    p_tr.add_argument("--resume", help="Path to a .safetensors checkpoint OR a "
                      "directory containing step-*.safetensors (uses latest)")
    p_tr.add_argument("--auto-lr-rewind", action="store_true",
                      help="On NaN or loss > N×recent_avg: restore last good ckpt + halve LR")
    p_tr.add_argument("--rewind-threshold", type=float, default=5.0,
                      help="Trigger rewind if loss > N × recent_avg (default 5.0)")
    p_tr.add_argument("--curriculum", default="",
                      help="Curriculum strategy: '' (random) | 'linear' (short→long)")
    p_tr.add_argument("--multi-dataset", default="",
                      help="Comma-separated path:weight pairs (e.g. 'a.pt:3.0,b.pt:1.0')")
    p_tr.add_argument("--only-flow-net", action="store_true",
                      help="MoshiVis-style: train ONLY flow_net + out_eos (LoRA-like minimal surface)")
    p_tr.add_argument("--auto-stop-plateau", type=int, default=0,
                      help="Stop if loss doesn't improve for N steps (0=disabled)")
    p_tr.add_argument("--plateau-tolerance", type=float, default=0.01,
                      help="Min relative drop to count as improvement (default 0.01 = 1 percent)")
    p_tr.add_argument("--torch-compile", action="store_true",
                      help="Enable torch.compile on flow_net (1.5-2× speedup, PyTorch 2.0+)")
    p_tr.add_argument("--log-every-steps", type=int, default=25,
                      help="Print loss every N steps (default 25)")
    p_tr.add_argument("--batch-size", type=int, default=2,
                      help="Per-step micro batch size (default 2)")
    p_tr.add_argument("--grad-accum", type=int, default=16,
                      help="Gradient accumulation steps (effective batch = batch-size × grad-accum)")
    p_tr.add_argument("--weight-decay", type=float, default=0.01,
                      help="AdamW weight decay (default 0.01)")
    p_tr.add_argument("--warmup-steps", type=int, default=200,
                      help="LR warmup steps (default 200)")
    p_tr.add_argument("--freeze-backbone-layers", type=int, default=4,
                      help="Freeze first N transformer blocks (0 = train all)")

    sub.add_parser("smoke", help="Smoke test on Mac CPU + synthetic data")

    args = p.parse_args()
    if args.cmd == "encode":
        encode_dataset(args.input, args.output, args.language,
                       args.max_samples, args.num_workers,
                       args.shard_index, args.num_shards,
                       augment_pitch=args.augment_pitch,
                       augment_speed=args.augment_speed)
    elif args.cmd == "train":
        multi = []
        if args.multi_dataset:
            for pair in args.multi_dataset.split(","):
                p, w = pair.rsplit(":", 1)
                multi.append((p.strip(), float(w)))
        train(FinetuneConfig(
            erinome_pt=args.tokens,
            output_dir=args.output,
            epochs=args.epochs,
            learning_rate=args.learning_rate,
            save_every_steps=args.save_every_steps,
            log_every_steps=args.log_every_steps,
            auto_lr_rewind=args.auto_lr_rewind,
            rewind_threshold=args.rewind_threshold,
            curriculum=args.curriculum,
            multi_dataset_weights=multi or None,
            only_flow_net=args.only_flow_net,
            auto_stop_plateau=args.auto_stop_plateau,
            plateau_tolerance=args.plateau_tolerance,
            use_torch_compile=args.torch_compile,
            micro_batch_size=args.batch_size,
            grad_accum=args.grad_accum,
            weight_decay=args.weight_decay,
            warmup_steps=args.warmup_steps,
            freeze_backbone_layers=args.freeze_backbone_layers,
        ), resume_from=args.resume)
    elif args.cmd == "smoke":
        ok = smoke()
        exit(0 if ok else 1)


if __name__ == "__main__":
    main()
