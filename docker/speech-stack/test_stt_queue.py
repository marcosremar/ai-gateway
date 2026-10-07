"""Unit test of the STT batcher's queue (no GPU, no faster-whisper): python3 docker/speech-stack/test_stt_queue.py"""
import sys
import threading
import time
import types

for name in ("faster_whisper", "faster_whisper.audio", "faster_whisper.tokenizer", "faster_whisper.transcribe"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["faster_whisper"].BatchedInferencePipeline = lambda model: None
sys.modules["faster_whisper"].WhisperModel = object
sys.modules["faster_whisper.audio"].pad_or_trim = None
sys.modules["faster_whisper.tokenizer"].Tokenizer = None
for attr in ("TranscriptionOptions", "get_compression_ratio", "get_suppressed_tokens"):
    setattr(sys.modules["faster_whisper.transcribe"], attr, None)

import numpy as np  # noqa: E402

from stt_batch import SttBatcher  # noqa: E402
from stt_stream import SttStream  # noqa: E402

release = threading.Event()
passes: list[list[str]] = []


class Fake(SttBatcher):
    def _decode(self, jobs):
        passes.append([job["prompt"] for job in jobs])
        release.wait(5)
        return [{"text": job["prompt"]} for job in jobs]


clip = np.zeros(1600, dtype=np.float32)


def call(batcher, name, partial=False):
    thread = threading.Thread(target=lambda: results.update({name: batcher.transcribe(clip, "pt", name, partial)}))
    thread.start()
    return thread


results: dict = {}
batcher = Fake(None, max_batch=1, window_ms=0)
threads = [call(batcher, "running")]
while not passes:
    time.sleep(0.005)
for name, partial in (("partial-1", True), ("partial-2", True), ("final-1", False), ("final-2", False)):
    threads.append(call(batcher, name, partial))
    time.sleep(0.02)
release.set()
for thread in threads:
    thread.join(5)
assert [p[0] for p in passes] == ["running", "final-1", "final-2", "partial-1", "partial-2"], passes
assert results["final-1"]["batch"] == 1 and results["final-1"]["queue_ms"] >= 20 and results["final-1"]["decode_ms"] >= 0, results

passes.clear()
alone = Fake(None, max_batch=8, window_ms=0)
started = time.monotonic()
assert alone.transcribe(clip, "pt", "solo")["queue_ms"] < 20
assert time.monotonic() - started < 0.2

waits = Fake(None, max_batch=8, window_ms=150)
started = time.monotonic()
assert waits.transcribe(clip, "pt", "solo")["queue_ms"] >= 140

passes.clear()
release.clear()
burst = Fake(None, max_batch=8, window_ms=0)
threads = [call(burst, "running")]
while not passes:
    time.sleep(0.005)
threads += [call(burst, "same") for _ in range(3)]
time.sleep(0.05)
release.set()
for thread in threads:
    thread.join(5)
assert passes == [["running"], ["same", "same", "same"]], passes


class Recorder:
    def __init__(self):
        self.partial = []

    def transcribe(self, audio, language, prompt=None, partial=False):
        self.partial.append(partial)
        return {"text": "oi"}


recorder = Recorder()
stream = SttStream(recorder, "pt", chunk_seconds=0.2)
stream.push((np.ones(16000, dtype=np.int16) * 3000).tobytes())
stream.tick()
stream.push((np.ones(16000, dtype=np.int16) * 3000).tobytes())
stream.finish()
assert recorder.partial == [True, False], recorder.partial
print("stt queue: ok")
