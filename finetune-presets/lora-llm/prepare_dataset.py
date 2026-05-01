"""
Prepare dataset for lora-llm fine-tune.

Accepts:
  - HF dataset with 'instruction'/'input'/'output' columns
  - HF dataset with 'messages' column (chat format)
  - Alpaca-format JSONL
  - ShareGPT-format JSONL

Outputs: /workspace/data/train.jsonl (normalized)

Usage:
    python prepare_dataset.py --src /workspace/data --out /workspace/data/train.jsonl [--max-samples N]
"""

import argparse, json, os
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--src", default="/workspace/data")
    p.add_argument("--out", default="/workspace/data/train.jsonl")
    p.add_argument("--max-samples", type=int, default=0)
    p.add_argument("--min-chars", type=int, default=20)
    args = p.parse_args()

    src = Path(args.src)

    # Find input file
    candidates = ["metadata.jsonl", "train.jsonl", "train.json", "data.jsonl"]
    input_path = next((src / c for c in candidates if (src / c).exists()), None)

    if input_path is None:
        jsonls = list(src.rglob("*.jsonl"))
        if not jsonls:
            print(f"No JSONL found in {src}")
            raise SystemExit(1)
        input_path = jsonls[0]

    print(f"Input: {input_path}")

    records = []
    with open(input_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            # Normalize to messages format
            if "messages" in d:
                msg = d["messages"]
            elif "instruction" in d:
                msg = [{"role": "user", "content": (d["instruction"] + "\n\n" + d.get("input", "")).strip()}]
                if "output" in d:
                    msg.append({"role": "assistant", "content": d["output"]})
            elif "conversations" in d:  # ShareGPT
                role_map = {"human": "user", "gpt": "assistant", "system": "system"}
                msg = [{"role": role_map.get(c["from"], c["from"]), "content": c["value"]} for c in d["conversations"]]
            else:
                continue

            # Filter too short
            total_chars = sum(len(m["content"]) for m in msg)
            if total_chars < args.min_chars:
                continue

            records.append({"messages": msg})

            if args.max_samples and len(records) >= args.max_samples:
                break

    print(f"Writing {len(records)} samples → {args.out}")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print("Done")


if __name__ == "__main__":
    main()
