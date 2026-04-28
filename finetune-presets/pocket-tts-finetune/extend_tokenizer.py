"""Extend pocket-tts SentencePiece tokenizer with paralinguistic tag tokens.

Steps implemented:
  1. Inject `[laugh] [sigh] [gasp] [cough] [sniff] [throat] [sneeze]` as new
     special tokens in sp.model (preserves original training).
  2. For each new token, initialize input embedding as mean of near-neighbor
     existing tokens (e.g. [sigh] ← mean(["ahh","ohh","mmm"])).
  3. Save extended tokenizer + new model.safetensors with extended embed weight.

Trainer can then use this extended model: tokenizer recognizes [tag] as single
token (not tokenized to chars), embedding starts in semantically-near zone.

Usage:
    python extend_tokenizer.py \\
        --base /root/pocket_tts/languages/portuguese \\
        --output /root/pocket_tts_extended

Then train with --model-dir /root/pocket_tts_extended (loads extended weights).

Note: SentencePiece doesn't natively support adding tokens after training.
We use sentencepiece_model_pb2 to inject pieces in the protobuf directly.
"""
from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

TAGS = ["[laugh]", "[sigh]", "[gasp]", "[cough]", "[sniff]", "[throat]", "[sneeze]"]

# Near-neighbor existing tokens to seed each new token's embedding
NEIGHBORS = {
    "[laugh]":  ["aha", "ah", "haha"],
    "[sigh]":   ["ahh", "oh", "uhh"],
    "[gasp]":   ["ah", "uh", "oh"],
    "[cough]":  ["uh", "ahem", "huh"],
    "[sniff]":  ["uhm", "hmm", "mh"],
    "[throat]": ["ahem", "uh", "uhh"],
    "[sneeze]": ["atchim", "achoo", "ah"],
}


def extend_sp_model(in_path: str, out_path: str, tags: list[str]) -> int:
    """Inject tag tokens into SentencePiece protobuf. Returns first new id."""
    from sentencepiece import sentencepiece_model_pb2 as model_pb2
    spm = model_pb2.ModelProto()
    with open(in_path, "rb") as f:
        spm.ParseFromString(f.read())

    base_size = len(spm.pieces)
    print(f"[ext] base vocab size: {base_size}")

    # Skip duplicates
    existing = {p.piece for p in spm.pieces}
    added_ids = []
    for tag in tags:
        if tag in existing:
            print(f"  skip {tag} (already present)")
            continue
        p = spm.pieces.add()
        p.piece = tag
        p.score = 0.0
        p.type = 4  # USER_DEFINED — special token, never split
        added_ids.append(len(spm.pieces) - 1)
        print(f"  + {tag} → id {len(spm.pieces) - 1}")

    with open(out_path, "wb") as f:
        f.write(spm.SerializeToString())
    print(f"[ext] saved → {out_path}  ({len(spm.pieces)} tokens, +{len(added_ids)})")
    return base_size  # first new id


def extend_embeddings(state_dict: dict, tokenizer_in_path: str,
                      base_size: int, tags: list[str]) -> dict:
    """Add rows to embedding/output matrices for new tokens.

    For each new tag, find neighbor tokens via SP encoding + average their
    embeddings → init the new row.
    """
    import sentencepiece as spm
    import torch

    sp = spm.SentencePieceProcessor(model_file=tokenizer_in_path)

    new_state = dict(state_dict)
    # Find embedding-shaped weights. Vocab size may include extra tokens (padding,
    # bos, etc.) — accept any tensor whose first dim is base_size OR base_size+1/2.
    candidates = set([base_size, base_size + 1, base_size + 2])
    for key, w in state_dict.items():
        if w.dim() < 2 or w.shape[0] not in candidates:
            continue
        added_rows = []
        for tag in tags:
            neighbors = NEIGHBORS.get(tag, [])
            ids = []
            for n in neighbors:
                tok_ids = sp.encode_as_ids(n)
                if tok_ids:
                    ids.extend(tok_ids)
            if not ids:
                # Fallback: zero row
                new_row = torch.zeros_like(w[0])
            else:
                ids = [i for i in ids if i < base_size]
                new_row = w[ids].mean(dim=0)
            added_rows.append(new_row)
        new_w = torch.cat([w] + [r.unsqueeze(0) for r in added_rows], dim=0)
        new_state[key] = new_w
        print(f"[emb] extended {key}: {tuple(w.shape)} → {tuple(new_w.shape)}")
    return new_state


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", required=True,
                    help="path to base pocket_tts language dir (with model.safetensors + tokenizer.model)")
    ap.add_argument("--output", required=True, help="output dir for extended model")
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    base_tok = Path(args.base) / "tokenizer.model"
    out_tok = out / "tokenizer.model"
    base_size = extend_sp_model(str(base_tok), str(out_tok), TAGS)

    # Extend embeddings
    from safetensors.torch import load_file, save_file
    base_st = Path(args.base) / "model.safetensors"
    sd = load_file(str(base_st))
    new_sd = extend_embeddings(sd, str(base_tok), base_size, TAGS)
    save_file(new_sd, str(out / "model.safetensors"))
    print(f"[done] extended model → {out}/")
    print(f"  next: train with --model-dir {out}")
    # Copy other files
    for f in Path(args.base).iterdir():
        if f.name not in ("tokenizer.model", "model.safetensors"):
            shutil.copy(f, out / f.name)


if __name__ == "__main__":
    main()
