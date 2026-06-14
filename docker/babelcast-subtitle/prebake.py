#!/usr/bin/env python3
"""
Build-time model pre-bake for babelcast-subtitle.

Downloads the STT (Faster Whisper) and LLM (TranslateGemma) weights into the
image's HuggingFace cache at BUILD time instead of on first boot. Per the
project's hard guidance (CLAUDE.md): pre-bake models at build time — validated
+24% faster vs lazy runtime download — and use hf-xet for the download.

The download targets must match server.py's STT_MODEL / LLM_MODEL defaults.
"""

import os
import sys

STT_MODEL = os.environ.get("STT_MODEL", "large-v3-turbo")
LLM_MODEL = os.environ.get("LLM_MODEL", "google/translate-gemma-12b-it")


def prebake_stt() -> None:
    """Materialize the Faster Whisper CTranslate2 weights into the HF cache."""
    print(f"[prebake] Downloading STT model: {STT_MODEL}", flush=True)
    # huggingface_hub resolves faster-whisper's repo id and caches all shards.
    from faster_whisper.utils import download_model

    download_model(STT_MODEL)
    print(f"[prebake] STT model cached: {STT_MODEL}", flush=True)


def prebake_llm() -> None:
    """Download the LLM weights + tokenizer into the HF cache (no GPU needed)."""
    print(f"[prebake] Downloading LLM model: {LLM_MODEL}", flush=True)
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=LLM_MODEL,
        # Skip duplicate/unused weight formats to keep the image lean.
        ignore_patterns=["*.gguf", "*.bin.index.json.bak", "*.msgpack", "*.h5"],
    )
    print(f"[prebake] LLM model cached: {LLM_MODEL}", flush=True)


if __name__ == "__main__":
    try:
        prebake_stt()
        prebake_llm()
    except Exception as exc:  # noqa: BLE001 — fail the build loudly
        print(f"[prebake] FAILED: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
    print("[prebake] All models pre-baked into image cache.", flush=True)
