"""Route-2 v12 flow-matching trainer — PHONEME-conditioned (replaces v11 hiddens).
Data in /root/r2_data:
  r2_mel_train_{concat.npy[sumLm,100]fp16, lengths.npy, ids.json}   (Vocos mel targets, from gen_mel.py)
  phon_vocab.json {token:int}  +  r2_phon_ids.json {id:[int,...]}    (from prep_phon_v12.py)
Loss = dur + prior + diff (OT-CFM). Mel standardized by scalar mean/std (baked into ckpt).
Checkpoints save model+optimizer+step (full-state, spot-resume friendly) and a train_state.pt.
Run detached:
  setsid nohup python3 -u /root/r2_train_v12.py --steps 30000 --batch 32 --out /root/r2_ckpt_v12 \
      >/root/r2_train_v12.log 2>&1 </dev/null & disown
"""
import argparse, json, os, time, random, re, subprocess
from pathlib import Path
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader
from r2_model_v12 import TucanoMatchaTTS, fix_len

P = argparse.ArgumentParser()
P.add_argument("--data", default="/root/r2_data")
P.add_argument("--mel_pref", default="r2_mel_train")
P.add_argument("--sharded_manifest", default="")  # file or dir with worker manifest jsonl records
P.add_argument("--sharded_root", default="")      # root for shard paths; defaults to --data
P.add_argument("--shard_cache_dir", default=os.environ.get("SHARD_CACHE_DIR", "/root/r2_shard_cache"))
P.add_argument("--shard_cache_max_gb", type=float, default=float(os.environ.get("SHARD_CACHE_MAX_GB", "20")))
P.add_argument("--out", default="/root/r2_ckpt_v12")
P.add_argument("--steps", type=int, default=30000)
P.add_argument("--batch", type=int, default=32)
P.add_argument("--lr", type=float, default=1e-4)
P.add_argument("--log_every", type=int, default=50)
P.add_argument("--save_every", type=int, default=2000)
P.add_argument("--workers", type=int, default=4)
P.add_argument("--holdout", type=int, default=256)
P.add_argument("--limit", type=int, default=0)
P.add_argument("--resume", default="")  # path to a r2_step*.pt to resume from
P.add_argument("--bf16", action="store_true")
P.add_argument("--jsonl", default="/root/r2_data/train_94k.jsonl")  # eval ref text source
P.add_argument("--eval_every", type=int, default=2000)   # 0 disables eval gate
P.add_argument("--eval_n", type=int, default=48)         # dev utts per eval
P.add_argument("--patience", type=int, default=4)        # early-stop: evals w/o sim gain
P.add_argument("--whisper", default="base")
P.add_argument("--n_timesteps", type=int, default=10)
P.add_argument("--hf_repo", default=os.environ.get("HF_REPO", ""))  # owner/name — live-push weights each save
P.add_argument("--hf_private", action="store_true")
# Finetune: pin mel standardization to the base ckpt's baked scalars so a
# warm-started model sees inputs in the same normalized space it was trained on.
# 0.0 => compute from data (fresh-train default).
P.add_argument("--mel_mean", type=float, default=0.0)
P.add_argument("--mel_std", type=float, default=0.0)
# Finetune mode: load base weights only — fresh optimizer (so --lr applies, not
# the base ckpt's baked LR) and step reset to 0 (so --steps counts finetune
# steps, not continuing the base's 22k). Plain --resume keeps opt+step (spot-resume).
P.add_argument("--finetune", action="store_true")
A = P.parse_args()
dev = "cuda"
os.makedirs(A.out, exist_ok=True)


def offsets(lengths):
    off = np.zeros(len(lengths) + 1, dtype=np.int64)
    np.cumsum(lengths, out=off[1:])
    return off


print("loading index...", flush=True)
SHARDED = bool(A.sharded_manifest)
shards = []
mel_c = mel_len = mel_ids = mel_off = None


def _is_rclone_path(path):
    return bool(re.match(r"^[A-Za-z0-9_-]+:", path)) and "://" not in path


def _join_path(root, rel):
    if _is_rclone_path(root):
        return f"{root.rstrip('/')}/{rel.lstrip('/')}"
    return os.path.join(root, rel)


class RcloneShardCache:
    """Small LRU cache for rclone remotes; avoids FUSE/mount requirements."""
    def __init__(self, cache_dir, max_gb):
        self.cache_dir = Path(cache_dir)
        self.max_bytes = int(max(0.0, max_gb) * (1024 ** 3))
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def is_remote(self, path):
        return _is_rclone_path(path)

    def _local_for(self, remote):
        safe = remote.replace(":", "/").lstrip("/")
        return self.cache_dir / safe

    def ensure(self, path):
        if not self.is_remote(path):
            return path
        local = self._local_for(path)
        if local.exists() and local.stat().st_size > 0:
            os.utime(local, None)
            return str(local)

        local.parent.mkdir(parents=True, exist_ok=True)
        lock = Path(str(local) + ".lock")
        tmp = Path(str(local) + f".tmp.{os.getpid()}")
        while True:
            try:
                lock.mkdir()
                break
            except FileExistsError:
                if local.exists() and local.stat().st_size > 0:
                    os.utime(local, None)
                    return str(local)
                time.sleep(0.2)
        try:
            if not (local.exists() and local.stat().st_size > 0):
                print(f"SHARD_CACHE_FETCH {path} -> {local}", flush=True)
                subprocess.run(["rclone", "copyto", path, str(tmp)], check=True)
                os.replace(tmp, local)
            os.utime(local, None)
        finally:
            tmp.unlink(missing_ok=True)
            try:
                lock.rmdir()
            except OSError:
                pass
        self.prune(keep=str(local))
        return str(local)

    def prune(self, keep=""):
        if self.max_bytes <= 0:
            return
        files = []
        total = 0
        for p in self.cache_dir.rglob("*"):
            if not p.is_file() or ".tmp." in p.name or p.name.endswith(".lock"):
                continue
            try:
                st = p.stat()
            except FileNotFoundError:
                continue
            total += st.st_size
            files.append((st.st_mtime, st.st_size, p))
        if total <= self.max_bytes:
            return
        target = int(self.max_bytes * 0.85)
        for _, size, p in sorted(files):
            if total <= target:
                break
            if keep and str(p) == keep:
                continue
            try:
                p.unlink()
                total -= size
                print(f"SHARD_CACHE_EVICT {p} cache_bytes={total}", flush=True)
            except FileNotFoundError:
                pass


SHARD_CACHE = RcloneShardCache(A.shard_cache_dir, A.shard_cache_max_gb)


def _np_load_cached(path, **kwargs):
    for attempt in range(3):
        local = SHARD_CACHE.ensure(path)
        try:
            return np.load(local, **kwargs)
        except FileNotFoundError:
            if not SHARD_CACHE.is_remote(path) or attempt == 2:
                raise
            time.sleep(0.2)
    raise FileNotFoundError(path)


def _manifest_files(path):
    if SHARD_CACHE.is_remote(path):
        return [SHARD_CACHE.ensure(path)]
    if os.path.isdir(path):
        base = os.path.join(path, "manifests") if os.path.isdir(os.path.join(path, "manifests")) else path
        return sorted(os.path.join(base, p) for p in os.listdir(base) if p.endswith(".jsonl"))
    return [path]


def _load_shards():
    root = A.sharded_root or A.data
    recs = []
    for mf in _manifest_files(A.sharded_manifest):
        for line in open(mf):
            line = line.strip()
            if line:
                recs.append(json.loads(line))
    if not recs:
        raise RuntimeError(f"no shard records found in {A.sharded_manifest}")
    out = []
    for rec in recs:
        pref = _join_path(root, rec["prefix"])
        lengths_path = SHARD_CACHE.ensure(pref + "_lengths.npy")
        ids_path = SHARD_CACHE.ensure(pref + "_ids.json")
        phon_path = SHARD_CACHE.ensure(pref + "_phon_ids.json")
        text_path = SHARD_CACHE.ensure(pref + "_text.jsonl")
        lengths = np.load(lengths_path)
        ids = json.load(open(ids_path))
        off = offsets(lengths)
        out.append({
            "prefix": pref,
            "mel_path": pref + "_mel.npy",
            "lengths_path": lengths_path,
            "lengths": lengths,
            "ids": ids,
            "offsets": off,
            "phon_path": phon_path,
            "text_path": text_path,
        })
    return out


if SHARDED:
    shards = _load_shards()
    _first = _np_load_cached(shards[0]["mel_path"], mmap_mode="r")
    N_FEATS = _first.shape[1]
    del _first
    print(f"mel shards={len(shards)} N_FEATS={N_FEATS}", flush=True)
    if _is_rclone_path(A.sharded_root or A.data) or _is_rclone_path(A.sharded_manifest):
        print(
            f"SHARD_CACHE dir={A.shard_cache_dir} max_gb={A.shard_cache_max_gb:g} "
            "mode=rclone-on-demand",
            flush=True,
        )
else:
    mel_c = np.load(f"{A.data}/{A.mel_pref}_concat.npy", mmap_mode="r")   # [sumLm,100]
    mel_len = np.load(f"{A.data}/{A.mel_pref}_lengths.npy")
    mel_ids = json.load(open(f"{A.data}/{A.mel_pref}_ids.json"))
    mel_off = offsets(mel_len)
    N_FEATS = mel_c.shape[1]
vocab = json.load(open(f"{A.data}/phon_vocab.json"))
phon_path = f"{A.data}/r2_phon_ids.json"
if os.path.exists(phon_path):
    phon = json.load(open(phon_path))   # {id: [int,...]}
elif SHARDED:
    phon = {}
    for sh in shards:
        if os.path.exists(sh["phon_path"]):
            phon.update(json.load(open(sh["phon_path"])))
    if not phon:
        raise RuntimeError("no root r2_phon_ids.json and no shard *_phon_ids.json files found")
else:
    raise FileNotFoundError(phon_path)
VOCAB = len(vocab)
if SHARDED:
    print(f"VOCAB={VOCAB} N_FEATS={N_FEATS}", flush=True)
else:
    print(f"mel sum={mel_c.shape} mel_ids={len(mel_ids)} VOCAB={VOCAB} N_FEATS={N_FEATS}", flush=True)

# pair phon+mel by id; MAS validity: Lh>=2 and Lm>=Lh
pairs, skip = [], 0
if SHARDED:
    for si, sh in enumerate(shards):
        for ui, sid in enumerate(sh["ids"]):
            ph = phon.get(sid)
            if not ph:
                skip += 1; continue
            Lh = len(ph); Lm = int(sh["lengths"][ui])
            if Lh < 2 or Lm < Lh:
                skip += 1; continue
            pairs.append((sid, si, ui, Lh, Lm))
else:
    for mi, sid in enumerate(mel_ids):
        ph = phon.get(sid)
        if not ph:
            skip += 1; continue
        Lh = len(ph); Lm = int(mel_len[mi])
        if Lh < 2 or Lm < Lh:
            skip += 1; continue
        pairs.append((sid, -1, mi, Lh, Lm))
if A.limit:
    pairs = pairs[: A.limit]
random.Random(1234).shuffle(pairs)
dev_pairs = pairs[: A.holdout]
train_pairs = pairs[A.holdout:]
json.dump([sid for sid, _, _, _, _ in dev_pairs], open(f"{A.out}/dev_ids.json", "w"))
pairs = train_pairs
print(f"pairs train={len(pairs)} dev={len(dev_pairs)} skip={skip}", flush=True)

# mel standardization scalars (subset) — or pinned from base ckpt for finetune
if A.mel_mean != 0.0 or A.mel_std != 0.0:
    MEL_MEAN = float(A.mel_mean); MEL_STD = float(A.mel_std)
    print(f"MEL_MEAN={MEL_MEAN:.4f} MEL_STD={MEL_STD:.4f} (PINNED for finetune)", flush=True)
else:
    rs = random.Random(0)
    samp = rs.sample(pairs, min(400, len(pairs)))
    def _stat_mel(si, ui, Lm):
        if SHARDED:
            sh = shards[si]
            mm = _np_load_cached(sh["mel_path"], mmap_mode="r")
            start = sh["offsets"][ui]
            return np.asarray(mm[start:start + Lm], dtype=np.float32)
        return np.asarray(mel_c[mel_off[ui]:mel_off[ui] + Lm], dtype=np.float32)
    vals = np.concatenate([_stat_mel(si, ui, Lm).reshape(-1)
                           for _, si, ui, _, Lm in samp])
    MEL_MEAN = float(vals.mean()); MEL_STD = float(vals.std() + 1e-6)
    print(f"MEL_MEAN={MEL_MEAN:.4f} MEL_STD={MEL_STD:.4f}", flush=True)
print("MILESTONE DATA_READY mel+phon paired, standardized", flush=True)

# ── eval-gate reference text for dev holdout ────────────────────────────────
import re as _re
from difflib import SequenceMatcher as _SM
def _norm(t):
    t = (t or "").lower().strip()
    t = _re.sub(r"[^\w\s]", " ", t, flags=_re.UNICODE)
    return _re.sub(r"\s+", " ", t).strip()
dev_text = {}
try:
    _want = set(sid for sid, _, _, _, _ in dev_pairs)
    for _l in open(A.jsonl):
        _l = _l.strip()
        if not _l:
            continue
        _o = json.loads(_l); _sid = _o.get("id")
        if _sid in _want:
            dev_text[_sid] = _o.get("speakable_text", "") or ""
    print(f"dev_text loaded={len(dev_text)}", flush=True)
except Exception as _e:
    print(f"dev_text load failed (eval gate disabled): {_e}", flush=True)
if SHARDED and len(dev_text) < len(dev_pairs):
    _want = set(sid for sid, _, _, _, _ in dev_pairs) - set(dev_text)
    for _tp in sorted(set(sh["text_path"] for sh in shards)):
        if not _want or not os.path.exists(_tp):
            continue
        for _l in open(_tp):
            _o = json.loads(_l); _sid = _o.get("id")
            if _sid in _want:
                dev_text[_sid] = _o.get("speakable_text", "") or ""
                _want.remove(_sid)
    print(f"dev_text from shards={len(dev_text)}", flush=True)


class DS(Dataset):
    def __init__(self, pairs):
        self.pairs = pairs
        self._mel_cache = {}

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, i):
        sid, si, ui, Lh, Lm = self.pairs[i]
        ph = torch.tensor(phon[sid], dtype=torch.long)                          # [Lh]
        if SHARDED:
            sh = shards[si]
            mm = self._mel_cache.get(si)
            if mm is None:
                mm = _np_load_cached(sh["mel_path"], mmap_mode="r")
                self._mel_cache[si] = mm
            start = sh["offsets"][ui]
            m = np.asarray(mm[start:start + Lm], dtype=np.float32)               # [Lm,100]
        else:
            m = np.asarray(mel_c[mel_off[ui]:mel_off[ui] + Lm], dtype=np.float32) # [Lm,100]
        m = (m - MEL_MEAN) / MEL_STD
        return ph, torch.from_numpy(m)


def collate(b):
    phs, ms = zip(*b)
    xl = torch.tensor([p.shape[0] for p in phs], dtype=torch.long)
    yl = torch.tensor([m.shape[0] for m in ms], dtype=torch.long)
    Lh = int(xl.max()); Lm = fix_len(int(yl.max()), 2)
    B = len(phs)
    x = torch.zeros(B, Lh, dtype=torch.long)            # phoneme IDs, pad=0
    y = torch.zeros(B, N_FEATS, Lm)                     # [B,100,Lm]
    for i, (p, m) in enumerate(zip(phs, ms)):
        x[i, : p.shape[0]] = p
        y[i, :, : m.shape[0]] = m.transpose(0, 1)
    return x, xl, y.contiguous(), yl


dl = DataLoader(DS(pairs), batch_size=A.batch, shuffle=True, num_workers=A.workers,
                collate_fn=collate, drop_last=True, pin_memory=True, persistent_workers=A.workers > 0)

model = TucanoMatchaTTS(in_dim=VOCAB).to(dev)
nparams = sum(p.numel() for p in model.parameters())
print(f"params={nparams/1e6:.2f}M in_proj={model.encoder.in_proj}", flush=True)
opt = torch.optim.AdamW(model.parameters(), lr=A.lr, weight_decay=1e-6)
amp_dt = torch.bfloat16 if A.bf16 else None

cfg = dict(in_dim=VOCAB, n_feats=N_FEATS, mel_mean=MEL_MEAN, mel_std=MEL_STD, lr=A.lr, batch=A.batch)
json.dump(cfg, open(f"{A.out}/config.json", "w"))
json.dump(vocab, open(f"{A.out}/phon_vocab.json", "w"), ensure_ascii=False)

step = 0
if A.resume and os.path.exists(A.resume):
    ck = torch.load(A.resume, map_location=dev)
    model.load_state_dict(ck["model"])
    if A.finetune:
        # weights only: keep the fresh AdamW (lr=A.lr) and step=0
        print(f"FINETUNE from {A.resume} (base step={int(ck.get('step', 0))}) — fresh opt lr={A.lr}, step reset to 0", flush=True)
    else:
        if "opt" in ck:
            opt.load_state_dict(ck["opt"])
        step = int(ck.get("step", 0))
        print(f"RESUMED from {A.resume} @ step={step}", flush=True)


def save(step):
    path = f"{A.out}/r2_step{step}.pt"
    torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "cfg": cfg, "step": step}, path)
    # latest pointer for spot-resume restore
    torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "cfg": cfg, "step": step},
               f"{A.out}/train_state.pt")
    print(f"MILESTONE CKPT step={step} -> {path}", flush=True)
    hf_push(step, "latest")


# ── HF Hub live-push: weights (model-only) each save -> versioned model repo ──
_hf = {"api": None}
def hf_push(step, tag="latest"):
    if not A.hf_repo:
        return
    try:
        from huggingface_hub import HfApi
        from safetensors.torch import save_file
        if _hf["api"] is None:
            _hf["api"] = HfApi(token=os.environ.get("HF_TOKEN"))
            _hf["api"].create_repo(A.hf_repo, private=A.hf_private, exist_ok=True, repo_type="model")
        sd = {k: v.detach().cpu().contiguous() for k, v in model.state_dict().items()}
        wpath = f"{A.out}/model.safetensors"
        save_file(sd, wpath, metadata={"step": str(step), "tag": tag})
        _hf["api"].upload_file(path_or_fileobj=wpath, path_in_repo="model.safetensors",
                               repo_id=A.hf_repo, repo_type="model")
        for fn in ("config.json", "phon_vocab.json"):
            p = f"{A.out}/{fn}"
            if os.path.exists(p):
                _hf["api"].upload_file(path_or_fileobj=p, path_in_repo=fn, repo_id=A.hf_repo, repo_type="model")
        print(f"MILESTONE HF_PUSH step={step} tag={tag} -> {A.hf_repo}", flush=True)
    except Exception as e:
        print(f"HF_PUSH_FAIL {e}", flush=True)


# ── eval gate: synthesise dev holdout -> Vocos -> whisper PT -> text_similarity ──
_evx = {"asr": None, "voc": None}
def eval_gate(n):
    try:
        import soundfile as sf, tempfile, numpy as _np, whisper as _w
        from vocos import Vocos as _V
        if _evx["voc"] is None:
            _evx["voc"] = _V.from_pretrained("charactr/vocos-mel-24khz").to(dev).eval()
        if _evx["asr"] is None:
            _evx["asr"] = _w.load_model(A.whisper, device=dev)
        sims = []
        model.eval()
        with torch.inference_mode():
            for sid, si, ui, Lh, Lm in dev_pairs[:n]:
                ref = dev_text.get(sid)
                if not ref:
                    continue
                ids = torch.tensor([phon[sid]], dtype=torch.long, device=dev)
                il = torch.tensor([len(phon[sid])], device=dev)
                mel, ylen, _ = model.synthesise(ids, il, n_timesteps=A.n_timesteps)
                Tt = int(ylen[0]); mel = mel[:, :, :Tt] * MEL_STD + MEL_MEAN
                audio = _evx["voc"].decode(mel).squeeze(0).float().cpu().numpy()
                with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
                    sf.write(tf.name, audio, 24000)
                    hyp = _evx["asr"].transcribe(tf.name, language="pt", fp16=True)["text"]
                sims.append(_SM(None, _norm(ref), _norm(hyp)).ratio())
        model.train()
        return float(_np.mean(sims)) if sims else 0.0
    except Exception as e:
        print(f"EVAL_FAIL {e}", flush=True); model.train(); return -1.0


t0 = time.time()
acc = {"dur": 0.0, "prior": 0.0, "diff": 0.0, "n": 0}
best_sim = -1.0
bad_evals = 0
stop = False
model.train()
print(f"MILESTONE TRAIN_START steps={A.steps} batch={A.batch} eval_every={A.eval_every} patience={A.patience}", flush=True)
while step < A.steps and not stop:
    for x, xl, y, yl in dl:
        x, xl, y, yl = x.to(dev), xl.to(dev), y.to(dev), yl.to(dev)
        opt.zero_grad(set_to_none=True)
        if amp_dt is not None:
            with torch.autocast("cuda", dtype=amp_dt):
                dur, prior, diff, _ = model(x, xl, y, yl)
            loss = dur + prior + diff
        else:
            dur, prior, diff, _ = model(x, xl, y, yl)
            loss = dur + prior + diff
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        opt.step()
        acc["dur"] += dur.item(); acc["prior"] += prior.item(); acc["diff"] += diff.item(); acc["n"] += 1
        step += 1
        if step % A.log_every == 0:
            n = acc["n"]; el = time.time() - t0
            print(f"step {step}/{A.steps} dur={acc['dur']/n:.4f} prior={acc['prior']/n:.4f} "
                  f"diff={acc['diff']/n:.4f} {el:.0f}s {step/el:.2f}it/s", flush=True)
            acc = {"dur": 0.0, "prior": 0.0, "diff": 0.0, "n": 0}
        if step % A.save_every == 0:
            save(step)
        if A.eval_every and step % A.eval_every == 0:
            sim = eval_gate(A.eval_n)
            print(f"MILESTONE EVAL step={step} sim_mean={sim:.4f} gate=0.55 best={max(best_sim,0):.4f}", flush=True)
            if sim > best_sim + 1e-4:
                best_sim = sim; bad_evals = 0
                torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "cfg": cfg, "step": step, "sim": sim}, f"{A.out}/best.pt")
                print(f"MILESTONE BEST sim={sim:.4f} step={step} -> best.pt", flush=True)
                hf_push(step, f"best-sim{sim:.3f}")
                if sim >= 0.55:
                    print(f"MILESTONE GATE_PASS sim={sim:.4f} >= 0.55 (production gate)", flush=True)
            else:
                bad_evals += 1
                print(f"MILESTONE NO_IMPROVE {bad_evals}/{A.patience} (best={best_sim:.4f})", flush=True)
                if bad_evals >= A.patience:
                    print(f"MILESTONE EARLY_STOP plateau: no sim gain in {A.patience} evals (best={best_sim:.4f})", flush=True)
                    stop = True
        if step >= A.steps or stop:
            break
save(step)
print(f"MILESTONE TRAIN_DONE step={step} best_sim={max(best_sim,0):.4f} t={time.time()-t0:.0f}s", flush=True)
print("PIPELINE_DONE", flush=True)
