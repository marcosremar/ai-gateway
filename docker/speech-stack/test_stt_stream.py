"""Streaming STT session logic (no GPU, no faster-whisper): python3 docker/speech-stack/test_stt_stream.py
Needs numpy. A fake batcher "hears" one word per run of 100 ms frames of the same loudness (0.05 + 0.01 × k → "wk")."""
import numpy as np

from stt_stream import SAMPLE_RATE, SttStream

FRAME = SAMPLE_RATE // 10


def word(k: int, seconds: float = 0.5) -> bytes:
    return (np.full(int(seconds * SAMPLE_RATE), (0.05 + 0.01 * k) * 32768, dtype=np.float32)).astype("<i2").tobytes()


def silence(seconds: float) -> bytes:
    return np.zeros(int(seconds * SAMPLE_RATE), dtype="<i2").tobytes()


class Ear:
    """Words = runs of ≥ 3 frames of one loudness; records every call."""

    def __init__(self):
        self.calls: list[dict] = []
        self.during = None

    def transcribe(self, audio, language, prompt=None, partial=False):
        self.calls.append({"samples": len(audio), "language": language, "prompt": prompt, "partial": partial})
        if self.during:
            self.during()
        levels = [round((float(np.sqrt(np.mean(f * f))) - 0.05) / 0.01) if np.abs(f).max() > 0.02 else None
                  for f in audio[: len(audio) // FRAME * FRAME].reshape(-1, FRAME)]
        words, run, last = [], 0, None
        for level in levels + [None]:
            if level == last:
                run += 1
                continue
            if last is not None and run >= 3:
                words.append(f"w{last}")
            last, run = level, 1
        return {"text": " ".join(words), "language": language or "pt", "avg_logprob": -0.2, "decode_ms": 5}


# ── segments: partials grow, the stable part only grows, silence ends the utterance ─────────────────────────────────
ear = Ear()
s = SttStream(ear, "pt", chunk_seconds=0.5, prompt="Kubernetes, Grafana", segments=True)
s.push(word(1) + word(2) + word(3))
out = s.tick()
assert out == [{"type": "partial", "utterance": 0, "text": "w1 w2 w3", "stable": "", "end_ms": 1500}], out
s.push(word(4))
out = s.tick()
assert out[0]["text"] == "w1 w2 w3 w4" and out[0]["stable"] == "w1 w2 w3", out
assert all(c["prompt"] == "Kubernetes, Grafana" and c["language"] == "pt" and c["partial"] for c in ear.calls), ear.calls
s.push(silence(1.0))
out = s.tick()
assert len(out) == 1 and out[0]["type"] == "final" and out[0]["text"] == "w1 w2 w3 w4" and out[0]["reason"] == "silence", out
assert out[0]["utterance"] == 0 and out[0]["start_ms"] == 0 and out[0]["end_ms"] == 3000 and out[0]["audio_ms"] == 3000, out
assert out[0]["avg_logprob"] == -0.2 and out[0]["language"] == "pt", out
assert len(ear.calls) == 3, "the decode that saw the silence is the final: no extra pass"
assert len(s.audio) == 0 and s.consumed == 3 * SAMPLE_RATE

s.push(word(5) + word(6))
out = s.tick()
assert out[0]["utterance"] == 1 and out[0]["text"] == "w5 w6" and out[0]["stable"] == "", out
out = s.finish()
assert out and out[0]["type"] == "final" and out[0]["reason"] == "flush" and out[0]["utterance"] == 1 and out[0]["start_ms"] == 3000, out
assert out[0]["text"] == "w5 w6" and not ear.calls[-1]["partial"], (out, ear.calls[-1])


# ── a stable word never changes, even when Whisper rewords the start ──────────────────────────────────────────────
class Script:
    def __init__(self, texts):
        self.texts = list(texts)

    def transcribe(self, audio, language, prompt=None, partial=False):
        return {"text": self.texts.pop(0)}


s = SttStream(Script(["a b c", "a b c d", "A B x d e", "a, b c d e f"]), "pt", chunk_seconds=0.2, segments=True)
seen = []
for _ in range(4):
    s.push(word(1, 0.3))
    seen += s.tick()
assert [m["text"] for m in seen] == ["a b c", "a b c d", "a b c d e", "a b c d e f"], seen
assert [m["stable"] for m in seen] == ["", "a b c", "a b c d", "a b c d e"], seen
for earlier, later in zip(seen, seen[1:]):
    assert later["text"].startswith(later["stable"]) and later["stable"].startswith(earlier["stable"]), (earlier, later)

# ── prompt and language change mid-stream ─────────────────────────────────────────────────────────────────────────
ear = Ear()
s = SttStream(ear, "pt", chunk_seconds=0.5, prompt="Ksawery Wiśniewski", segments=True)
s.push(word(1))
s.tick()
assert s.configure(prompt="Kestrel, Sirocco", language="fr") == {"type": "config", "language": "fr", "prompt_chars": 16}
s.push(word(2))
s.tick()
assert [(c["prompt"], c["language"]) for c in ear.calls] == [("Ksawery Wiśniewski", "pt"), ("Kestrel, Sirocco", "fr")], ear.calls
s.configure(clear_prompt=True)
assert s.prompt is None and s.configure(prompt="x" * 9000)["prompt_chars"] == 4000

# ── a full window is cut at its quietest point: the head is the final, the rest opens the next window ─────────────
ear = Ear()
s = SttStream(ear, "pt", chunk_seconds=1.0, window_seconds=5.0, segments=True)
speech = word(1) + word(2) + word(3) + word(4) + word(5) + word(6) + word(7) + word(8) + silence(0.3) + word(9) + word(10) + word(11)
s.push(speech)  # 5.8 s, the only pause at 4.0–4.3 s
out = s.tick()
assert len(out) == 1 and out[0]["reason"] == "max_length" and out[0]["text"] == "w1 w2 w3 w4 w5 w6 w7 w8", out
assert ear.calls[-1]["samples"] == int(4.05 * SAMPLE_RATE) and not ear.calls[-1]["partial"], ear.calls[-1]
assert s.consumed == int(4.05 * SAMPLE_RATE) and out[0]["end_ms"] == 4050, (s.consumed, out)
s.push(silence(1.0))
out = s.tick()
assert out[0]["type"] == "final" and out[0]["text"] == "w9 w10 w11" and out[0]["utterance"] == 1, out
assert out[0]["start_ms"] == 4050, "the second window starts where the first was cut: no audio decoded twice"

# ── silence is never decoded (Whisper invents words over it) ──────────────────────────────────────────────────────
ear = Ear()
s = SttStream(ear, "pt", chunk_seconds=0.5, segments=True)
s.push(silence(2.0))
assert s.tick() == [] and not ear.calls and len(s.audio) == int(0.2 * SAMPLE_RATE), (ear.calls, len(s.audio))
s.push(word(3) + silence(1.0))
out = s.tick()
assert out[0]["type"] == "final" and out[0]["text"] == "w3" and out[0]["start_ms"] == 1800, out
assert SttStream(Ear(), "pt", segments=True).finish() == []

# ── audio pushed while a decode runs is kept (and still counts as new) ────────────────────────────────────────────
ear = Ear()
s = SttStream(ear, "pt", chunk_seconds=0.5, segments=True)
ear.during = lambda: s.push(word(7))
s.push(word(1) + silence(1.0))
out = s.tick()
ear.during = None
assert out[0]["type"] == "final" and out[0]["text"] == "w1", out
assert len(s.audio) == SAMPLE_RATE // 2 and s.undecoded == SAMPLE_RATE // 2, (len(s.audio), s.undecoded)
assert s.tick()[0]["text"] == "w7"

# ── a failed decode is reported and the stream goes on ────────────────────────────────────────────────────────────


class Flaky(Ear):
    def transcribe(self, audio, language, prompt=None, partial=False):
        if not self.calls:
            self.calls.append({})
            raise RuntimeError("CUDA out of memory")
        return super().transcribe(audio, language, prompt, partial)


s = SttStream(Flaky(), "pt", chunk_seconds=0.5, segments=True)
s.push(word(2))
assert s.tick()[0]["type"] == "error"
s.push(word(2))
assert s.tick()[0]["text"] == "w2"

# ── legacy shape (the gateway's StreamingSTTRouter): the whole running text, "final" on a commit ──────────────────
ear = Ear()
s = SttStream(ear, "pt", chunk_seconds=0.5)
s.push(word(1) + word(2))
assert s.tick() == [{"text": "w1 w2"}]
s.push(silence(1.0))
assert s.tick() == [] and s.committed == "w1 w2", "a commit that changes nothing sends nothing (as before)"
s.push(word(3))
assert s.tick() == [{"text": "w1 w2 w3"}]
assert s.finish() == [{"text": "w1 w2 w3", "final": True}]
print("stt stream: ok — partials with a stable prefix that never changes, finals on silence / full window (cut at the "
      "quietest point, no overlap) / flush, the prompt on every decode, silence never decoded, legacy shape unchanged")
