"""
codec-tts fine-tune preset — works with VUI (resemble-ai/vui) and compatible codec TTS models.

Usage (direct):
    python trainer.py \
        --jsonl /workspace/data/train.jsonl \
        --wav-root /workspace/data/wav \
        --base-model /root/model/vui-100m-base.pt \
        --out /workspace/checkpoints \
        --steps 3000 --lr 3e-5 --batch 4

Requires: pip install git+https://github.com/resemble-ai/vui.git
"""

import argparse, json, math, os, random, sys, time, threading
from pathlib import Path

import numpy as np
import soundfile as sf_lib
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

from vui.model import Vui


def _hf_check_storage(hf_repo: str, hf_token: str) -> bool:
    """Return True if repo is writable (storage not exceeded). Warn and return False if full."""
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=hf_token)
        info = api.repo_info(repo_id=hf_repo, repo_type="model", token=hf_token)
        used = getattr(info, 'usedStorageBytes', None) or 0
        limit = getattr(info, 'storageLimitBytes', None)
        if limit and used >= limit * 0.95:
            used_gb = used / 1e9
            limit_gb = limit / 1e9
            print(f"  [hf] ⚠ storage {used_gb:.1f}/{limit_gb:.1f} GB — nearly full, pushes will fail!")
            return False
        return True
    except Exception as e:
        # Can't check = assume OK, don't block training
        print(f"  [hf] storage check skipped: {e}")
        return True


def _hf_push(ckpt_path: str, hf_repo: str, hf_token: str):
    """Push checkpoint to HF Hub in background thread (non-blocking)."""
    def _upload():
        try:
            from huggingface_hub import HfApi
            api = HfApi(token=hf_token)
            filename = os.path.basename(ckpt_path)
            api.upload_file(path_or_fileobj=ckpt_path, path_in_repo=filename,
                            repo_id=hf_repo, repo_type="model")
            api.upload_file(path_or_fileobj=ckpt_path, path_in_repo="latest.pt",
                            repo_id=hf_repo, repo_type="model")
            print(f"  [hf] pushed {filename} → {hf_repo}")
        except Exception as e:
            print(f"  [hf] push failed (non-fatal): {e}")
    threading.Thread(target=_upload, daemon=True).start()


def _hf_download_resume(resume_from: str, hf_token: str) -> str:
    """If resume_from starts with hf://, download from HF Hub and return local path."""
    if not resume_from.startswith("hf://"):
        return resume_from
    # hf://owner/repo/filename  or  hf://owner/repo  (defaults to latest.pt)
    parts = resume_from[5:].split("/")
    repo_id = "/".join(parts[:2])
    filename = parts[2] if len(parts) > 2 else "latest.pt"
    local = f"/tmp/hf_resume_{filename}"
    try:
        from huggingface_hub import hf_hub_download
        local = hf_hub_download(repo_id=repo_id, filename=filename, token=hf_token,
                                local_dir="/tmp", local_dir_use_symlinks=False)
        print(f"  [hf] downloaded resume checkpoint: {repo_id}/{filename} → {local}")
    except Exception as e:
        print(f"  [hf] resume download failed: {e} — starting from scratch")
        return ""
    return local


# ── Dataset ───────────────────────────────────────────────────────────────────

class ErinomeDataset(Dataset):
    def __init__(self, jsonl_path: str, wav_root: str, max_audio_sec: float = 10.0):
        self.wav_root = Path(wav_root)
        self.max_audio_sec = max_audio_sec
        self.samples = []
        with open(jsonl_path) as f:
            for line in f:
                d = json.loads(line)
                # resolve relative path
                wav = Path(d["audio"])
                if not wav.is_absolute():
                    wav = self.wav_root / wav.name
                if wav.exists():
                    self.samples.append({"wav": str(wav), "text": d["text"]})
        print(f"Dataset: {len(self.samples)} samples from {jsonl_path}")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        s = self.samples[idx]
        data, sr = sf_lib.read(s["wav"], dtype="float32", always_2d=True)
        wav = torch.from_numpy(data.T)  # [C, T]
        # mono
        if wav.shape[0] > 1:
            wav = wav.mean(0, keepdim=True)
        # resample to 22050 using julius
        if sr != 22050:
            import julius
            wav = julius.resample_frac(wav, sr, 22050)
        # trim to max_audio_sec
        max_samples = int(self.max_audio_sec * 22050)
        if wav.shape[-1] > max_samples:
            wav = wav[..., :max_samples]
        return {"wav": wav, "text": s["text"]}


def collate_fn(batch):
    return batch  # variable length — handle in training loop


# ── Training ──────────────────────────────────────────────────────────────────

def encode_audio(model: Vui, wav: torch.Tensor, device: str) -> torch.Tensor:
    """WAV → codec codes [1, Q, T]"""
    wav = wav.to(device)
    if wav.dim() == 2:
        wav = wav.unsqueeze(0)  # [1, C, T]
    # codec.encode uses @inference_mode internally; clone() outside any context
    # turns the inference tensor into a regular autograd-compatible tensor
    codes = model.codec.encode(wav)
    return codes.clone()  # exits inference_mode ownership


def forward_loss(model: Vui, text: str, codes: torch.Tensor, device: str) -> torch.Tensor:
    """
    Teacher-forcing forward pass.
    codes: [1, Q, T]  — ground truth audio codes
    Returns scalar cross-entropy loss averaged over Q quantizers and T steps.
    """
    Q = model.config.model.n_quantizers
    codes = codes[:, :Q].to(device).long()  # [1, Q, T]  cross_entropy needs int64
    T_audio = codes.shape[-1]

    # Text embeddings
    encoded = model.tokenizer([text], padding="longest")
    input_ids = torch.tensor(encoded["input_ids"]).to(device)
    text_emb = model.token_emb(input_ids)          # [1, T_text, D]
    T_text = text_emb.shape[1]

    # Audio embeddings (teacher forcing: shift by 1, prepend zeros)
    # input at step t = codes[:, :, t-1]; target at step t = codes[:, :, t]
    special = model.config.model.special_token_id
    pad = torch.full((1, Q, 1), special, dtype=torch.long, device=device)
    codes_in = torch.cat([pad, codes[:, :, :-1]], dim=-1)  # [1, Q, T]

    audio_emb = sum(
        model.audio_embeddings[q](codes_in[:, q])   # [1, T, D]
        for q in range(Q)
    ) / Q

    # Full sequence: text + audio
    emb = torch.cat([text_emb, audio_emb], dim=1)  # [1, T_text+T_audio, D]
    T_total = emb.shape[1]
    input_pos = torch.arange(T_total, device=device)

    # Forward (no KV cache — full attention for training)
    out = model.decoder(emb, input_pos)             # [1, T_total, D]

    # Logits only at audio positions
    audio_out = out[:, T_text:, :]                  # [1, T_audio, D]

    loss = torch.tensor(0.0, device=device)
    for q in range(Q):
        logits = model.audio_heads[q](audio_out)    # [1, T_audio, vocab]
        # shift: predict codes[q, t] from out[t]
        loss += F.cross_entropy(
            logits[0],          # [T_audio, vocab]
            codes[0, q],        # [T_audio]
            ignore_index=special,
        )
    return loss / Q


def train(args):
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")

    # Load model
    print(f"Loading base model: {args.base_model}")
    model = Vui.from_pretrained(args.base_model).to(device)
    model.train()

    # Freeze codec — only train transformer + heads
    for p in model.codec.parameters():
        p.requires_grad_(False)

    # Optionally freeze text embedding too (preserve text knowledge)
    if args.freeze_text_emb:
        model.token_emb.requires_grad_(False)
        print("Text embedding frozen")

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"Trainable params: {trainable:,}")

    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad],
        lr=args.lr, weight_decay=0.01,
    )

    # Resolve HF token (env var takes precedence over --hf-token arg)
    hf_token = os.environ.get("HF_TOKEN", "") or (args.hf_token or "")

    # HF storage preflight: warn early if repo is nearly full (avoids silent push failures at the end)
    if args.hf_repo and hf_token:
        _hf_check_storage(args.hf_repo, hf_token)

    # Optionally resume from checkpoint — restores model + optimizer + step
    start_step = 0
    resume_path = args.resume_from or ""
    if resume_path.startswith("hf://"):
        resume_path = _hf_download_resume(resume_path, hf_token)
    if resume_path and os.path.exists(resume_path):
        print(f"Resuming from: {resume_path}")
        ckpt = torch.load(resume_path, map_location=device, weights_only=False)
        model.load_state_dict(ckpt["model"])
        start_step = ckpt.get("step", 0)
        print(f"Resumed at step {start_step}")
    elif resume_path:
        print(f"Resume checkpoint not found: {resume_path} — starting from scratch")

    # Cosine LR with warmup — schedule spans full run (start_step → start_step+steps)
    # LambdaLR passes last_epoch which starts at 0 and increments each scheduler.step().
    # We set last_epoch=start_step so the curve is continuous across resumes without
    # fast-forwarding (fast-forward was O(start_step) and caused wraparound when
    # start_step > args.steps due to cosine being periodic).
    total_steps = start_step + args.steps
    warmup_steps = min(200, total_steps // 10)
    def lr_lambda(epoch):
        # epoch = last_epoch = absolute step number (set via last_epoch= below)
        if epoch < warmup_steps:
            return epoch / max(1, warmup_steps)
        progress = min(1.0, (epoch - warmup_steps) / max(1, total_steps - warmup_steps))
        return max(0.0, 0.5 * (1.0 + math.cos(math.pi * progress)))
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lr_lambda, last_epoch=start_step - 1 if start_step > 0 else -1
    )

    # Restore optimizer state if checkpoint has it (smooth resume — no loss spike)
    if resume_path and os.path.exists(resume_path):
        ckpt_opt = torch.load(resume_path, map_location=device, weights_only=False)
        if "optimizer" in ckpt_opt:
            try:
                optimizer.load_state_dict(ckpt_opt["optimizer"])
                print(f"  optimizer state restored")
            except Exception as e:
                print(f"  optimizer restore skipped ({e})")

    # Dataset
    dataset = ErinomeDataset(args.jsonl, args.wav_root, max_audio_sec=args.max_audio_sec)
    indices = list(range(len(dataset)))

    # Disable KV cache for training (full attention)
    for block in model.decoder.blocks:
        block.attn.kv_cache = None

    os.makedirs(args.out, exist_ok=True)
    best_loss = float("inf")
    running_loss = 0.0
    log_every = 50
    save_every = 250
    step = 0
    random.shuffle(indices)
    idx_pos = 0

    print(f"Starting training: {args.steps} steps (resuming from {start_step}), lr={args.lr}, batch={args.batch}")
    t0 = time.perf_counter()

    while step < args.steps:
        batch_loss = torch.tensor(0.0, device=device)
        valid = 0

        for _ in range(args.batch):
            if idx_pos >= len(indices):
                random.shuffle(indices)
                idx_pos = 0
            sample = dataset[indices[idx_pos]]
            idx_pos += 1

            try:
                codes = encode_audio(model, sample["wav"], device)
                if codes.shape[-1] < 4:
                    continue
                loss = forward_loss(model, sample["text"], codes, device)
                if torch.isnan(loss) or torch.isinf(loss):
                    continue
                batch_loss = batch_loss + loss
                valid += 1
            except Exception as e:
                print(f"  skip: {e}")
                continue

        if valid == 0:
            continue

        batch_loss = batch_loss / valid
        optimizer.zero_grad()
        batch_loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        scheduler.step()
        step += 1

        running_loss += batch_loss.item()
        abs_step = start_step + step

        if step % log_every == 0:
            avg = running_loss / log_every
            elapsed = time.perf_counter() - t0
            lr_now = scheduler.get_last_lr()[0]
            print(f"step={abs_step}/{start_step + args.steps}  loss={avg:.4f}  lr={lr_now:.2e}  {elapsed:.0f}s")
            running_loss = 0.0
            if avg < best_loss:
                best_loss = avg

        if step % save_every == 0 or step == args.steps:
            ckpt_path = os.path.join(args.out, f"erinome_step{abs_step}.pt")
            tmp_path = ckpt_path + ".tmp"
            torch.save({
                "model": model.state_dict(),
                "optimizer": optimizer.state_dict(),
                "config": model.config.__dict__,
                "step": abs_step,
                "loss": running_loss,
            }, tmp_path)
            os.replace(tmp_path, ckpt_path)  # atomic rename — rsync never sees partial write
            print(f"  saved {ckpt_path}")
            if args.hf_repo and hf_token:
                _hf_push(ckpt_path, args.hf_repo, hf_token)

    print(f"Done. Best loss: {best_loss:.4f}")


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--jsonl", required=True)
    p.add_argument("--wav-root", required=True)
    p.add_argument("--base-model", default="vui-100m-base.pt")
    p.add_argument("--out", default="checkpoints/erinome")
    p.add_argument("--steps", type=int, default=2000)
    p.add_argument("--lr", type=float, default=5e-5)
    p.add_argument("--batch", type=int, default=4)
    p.add_argument("--max-audio-sec", type=float, default=8.0)
    p.add_argument("--freeze-text-emb", action="store_true", default=True)
    p.add_argument("--resume-from", default=None, help="checkpoint .pt or hf://owner/repo[/file] to warm-start from")
    p.add_argument("--hf-repo", default=None, help="HF repo id to push checkpoints (e.g. marcosremar2/vui-ptbr-checkpoints)")
    p.add_argument("--hf-token", default=None, help="HuggingFace token (or set HF_TOKEN env var)")
    args = p.parse_args()
    train(args)
