"""Unit test of the WAV fast path (no GPU): python3 docker/speech-stack/test_wav_fast_path.py"""
import io
import shutil
import struct
import subprocess
import wave
from pathlib import Path

import numpy as np

src = Path(__file__).with_name("server.py").read_text()
ns: dict = {"io": io, "wave": wave, "struct": struct, "np": np}
exec(src[src.index("def wav_pcm16_16k"):src.index("def decode_16k")], ns)
fast = ns["wav_pcm16_16k"]


def wav(samples: np.ndarray, rate: int = 16000, channels: int = 1, width: int = 2) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    return buf.getvalue()


pcm = (np.sin(np.arange(16000) / 20) * 20000).astype("<i2")
clip = wav(pcm)
got = fast(clip)
assert got is not None and got.dtype == np.float32 and len(got) == 16000
assert np.array_equal(got, pcm.astype(np.float32) / 32768.0)
assert fast(wav(pcm, rate=24000)) is None
assert fast(wav(np.repeat(pcm, 2), channels=2)) is None
assert fast(wav(pcm.astype("<i4"), width=4)) is None
assert fast(b"") is None and fast(b"OggS" + bytes(64)) is None and fast(clip[:20]) is None
assert fast(wav(pcm[:0])) is None
assert len(fast(clip[:-1])) == 15999
float_wav = bytearray(clip)
float_wav[20:22] = struct.pack("<H", 3)
assert fast(bytes(float_wav)) is None
streamed = bytearray(clip)
streamed[40:44] = struct.pack("<I", 0)
assert fast(bytes(streamed)) is None
if shutil.which("ffmpeg"):
    out = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
                         input=clip, capture_output=True, check=True).stdout
    assert np.array_equal(got, np.frombuffer(out, dtype=np.float32))
print("wav fast path: ok")
