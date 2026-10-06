"""CPU check of stt_batch.py with Whisper tiny: concurrent clips are batched and transcribe like the one-at-a-time path.

    STT_TEST_MODEL=tiny python3 test_stt_batch.py clip1.wav clip2.wav …
"""
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from faster_whisper import WhisperModel

from stt_batch import SttBatcher


def load(path):
    out = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


model = WhisperModel(os.environ.get("STT_TEST_MODEL", "tiny"), device="cpu", compute_type="int8")
clips = [load(p) for p in sys.argv[1:]]
batcher = SttBatcher(model, max_batch=8, window_ms=50)
alone = [batcher._one({"audio": c, "language": "pt", "prompt": None})["text"] for c in clips]
with ThreadPoolExecutor(len(clips)) as pool:
    together = list(pool.map(lambda c: batcher.transcribe(c, "pt")["text"], clips))
silence = batcher.transcribe(np.zeros(16000, dtype=np.float32), "pt")["text"]
silence_alone = batcher._one({"audio": np.zeros(16000, dtype=np.float32), "language": "pt", "prompt": None})["text"]
print("alone   ", alone)
print("together", together)
print("silence ", repr(silence), repr(silence_alone), "stats", batcher.stats)
assert len(silence) < 80, "silence must not come back as a repetition loop"
norm = lambda t: "".join(ch for ch in t.lower() if ch.isalnum())  # noqa: E731
assert batcher.stats["largest"] == len(clips), batcher.stats
assert [norm(t) for t in alone] == [norm(t) for t in together]
print("ok")
