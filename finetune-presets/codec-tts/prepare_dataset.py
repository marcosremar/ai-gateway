"""
Convert cml_tts_dataset_portuguese parquet files → JSONL + WAV files
compatible with finetune_vui.py format.

Usage: uv run python3 prepare_cml.py --src /workspace/cml_tts --out /workspace/cml_prepared --max-hours 8
"""
import argparse, json, os, io
from pathlib import Path
import soundfile as sf
import numpy as np

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--src", default="/workspace/cml_tts")
    p.add_argument("--out", default="/workspace/cml_prepared")
    p.add_argument("--max-hours", type=float, default=8.0)
    p.add_argument("--min-chars", type=int, default=10)
    p.add_argument("--max-chars", type=int, default=300)
    args = p.parse_args()

    try:
        import pandas as pd
    except ImportError:
        os.system("pip install pandas pyarrow -q")
        import pandas as pd

    out_wav = Path(args.out) / "wav"
    out_wav.mkdir(parents=True, exist_ok=True)
    jsonl_path = Path(args.out) / "cml_tts.jsonl"

    parquet_files = sorted(Path(args.src).rglob("*.parquet"))
    print(f"Found {len(parquet_files)} parquet files")

    total_sec = 0.0
    max_sec = args.max_hours * 3600
    written = 0

    with open(jsonl_path, "w") as jf:
        for pf in parquet_files:
            if total_sec >= max_sec:
                break
            print(f"  {pf.name}...", flush=True)
            try:
                df = pd.read_parquet(pf)
            except Exception as e:
                print(f"    skip {pf.name}: {e}")
                continue

            # Find audio and text columns
            audio_col = next((c for c in df.columns if "audio" in c.lower()), None)
            text_col = next((c for c in df.columns if c.lower() in ("sentence", "text", "transcription", "normalized_text", "transcript")), None)
            if not audio_col or not text_col:
                print(f"    cols: {list(df.columns)} — skip")
                continue

            for i, row in df.iterrows():
                if total_sec >= max_sec:
                    break
                text = str(row[text_col]).strip()
                if len(text) < args.min_chars or len(text) > args.max_chars:
                    continue

                # Audio: dict with 'bytes' or 'array'+'sampling_rate'
                audio = row[audio_col]
                try:
                    if isinstance(audio, dict) and "bytes" in audio and audio["bytes"]:
                        wav_data, sr = sf.read(io.BytesIO(audio["bytes"]), dtype="float32")
                    elif isinstance(audio, dict) and "array" in audio:
                        wav_data = np.array(audio["array"], dtype="float32")
                        sr = audio.get("sampling_rate", 22050)
                    else:
                        continue
                except Exception:
                    continue

                if wav_data.ndim > 1:
                    wav_data = wav_data.mean(axis=1)

                dur = len(wav_data) / sr
                if dur < 1.0 or dur > 15.0:
                    continue

                wav_name = f"cml_{written:07d}.wav"
                wav_path = out_wav / wav_name
                sf.write(str(wav_path), wav_data, sr)

                jf.write(json.dumps({"audio": wav_name, "text": text}, ensure_ascii=False) + "\n")
                total_sec += dur
                written += 1

                if written % 500 == 0:
                    print(f"    {written} samples, {total_sec/3600:.2f}h", flush=True)

    print(f"\nDone: {written} samples, {total_sec/3600:.2f}h → {jsonl_path}")

if __name__ == "__main__":
    main()
