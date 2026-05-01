"""Stage F.2 — Convert train_raw_v4.jsonl into pocket-tts trainer format.

Input rows:
    {"audio": "../erinome_full/wav/X.wav",
     "text": "<sigh> Meu celular descarregou.",
     "language": "pt",
     "tokens": "<sigh>",
     "instruction": "Include a sigh"}

Output rows (matches trainer.encode_dataset expectation):
    {"audio": "/abs/path/to/X.wav",
     "text": "[sigh] Meu celular descarregou.",
     "tag_positions": [{"name": "sigh", "char_pos": 0}],
     "language": "pt"}

Usage:
    python prepare_dataset.py \\
        --input  ../training_data/train_raw_v4.jsonl \\
        --output erinome_with_tags.jsonl \\
        --wav-root /root/iaratts/erinome_full
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter
from pathlib import Path

TAG_MAP = {
    "<sigh>": "sigh",
    "<laugh>": "laugh",
    "<cough>": "cough",
    "<gasp>": "gasp",
    "<groan>": "sigh",
    "<chuckle>": "laugh",
    "<sniffle>": "sniff",
    "<yawn>": "sigh",
}
INLINE_RE = re.compile(r"<(sigh|laugh|cough|gasp|groan|chuckle|sniffle|yawn)>")


def convert_text(text: str) -> tuple[str, list[dict]]:
    positions: list[dict] = []
    out = []
    cursor = 0
    last = 0
    for m in INLINE_RE.finditer(text):
        out.append(text[last:m.start()])
        cursor += m.start() - last
        canonical = TAG_MAP[m.group(0)]
        positions.append({"name": canonical, "char_pos": cursor})
        rendered = f"[{canonical}]"
        out.append(rendered)
        cursor += len(rendered)
        last = m.end()
    out.append(text[last:])
    return "".join(out).strip(), positions


def resolve_audio(rel: str, wav_root: Path | None) -> str:
    if wav_root is None:
        return rel
    name = Path(rel).name
    return str((wav_root / "wav" / name).resolve())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument(
        "--wav-root",
        help="Absolute path to erinome_full (where /wav/ lives). "
             "Leave unset to keep relative paths.",
    )
    ap.add_argument("--require-exists", action="store_true",
                    help="Skip rows where the wav doesn't exist on disk.")
    ap.add_argument("--max", type=int, default=0, help="Cap rows for smoke test.")
    args = ap.parse_args()

    wav_root = Path(args.wav_root) if args.wav_root else None
    in_p, out_p = Path(args.input), Path(args.output)

    counts = Counter()
    skipped_missing = 0
    written = 0

    with in_p.open() as fin, out_p.open("w") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            audio = resolve_audio(row["audio"], wav_root)
            if args.require_exists and not os.path.exists(audio):
                skipped_missing += 1
                continue
            text, positions = convert_text(row["text"])
            for p in positions:
                counts[p["name"]] += 1
            counts["__total__"] += 1
            if not positions:
                counts["__plain__"] += 1
            fout.write(json.dumps({
                "audio": audio,
                "text": text,
                "tag_positions": positions,
                "language": row.get("language", "pt"),
            }, ensure_ascii=False) + "\n")
            written += 1
            if args.max and written >= args.max:
                break

    print(f"wrote {written} rows → {out_p}")
    if skipped_missing:
        print(f"  skipped {skipped_missing} (audio missing)")
    print("tag distribution:")
    for name, n in counts.most_common():
        print(f"  {name:>12} {n}")


if __name__ == "__main__":
    main()
