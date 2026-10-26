"""Same cursor as the Rust and Node SDKs. Run: python test_growing.py"""

import sys

# This folder has types.py, which shadows the stdlib if it stays on sys.path.
sys.path.pop(0)

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("growing_utt", Path(__file__).resolve().parent / "growing.py")
g = importlib.util.module_from_spec(_spec)
sys.modules["growing_utt"] = g
_spec.loader.exec_module(g)


def test_uploads_only_the_new_audio_and_joins_the_line() -> None:
    u = g.GrowingUtterance()
    first = u.piece(4 * 16_000)
    assert first is not None and first.start == 0 and not first.continued
    assert u.accept(False, "a reunião começa agora", 4 * 16_000) == "a reunião começa agora"
    tail = u.piece(6 * 16_000)
    assert tail is not None and tail.continued and tail.start == g.DRAFT_OVERLAP_SAMPLES
    assert u.accept(True, "começa agora e o orçamento", 6 * 16_000) == "a reunião começa agora e o orçamento"
    assert u.piece(6 * 16_000) is None
    assert u.accept(True, "o tempo fechou de vez", 8 * 16_000) is None
    again = u.piece(8 * 16_000)
    assert again is not None and again.start == 0
    wav = g.wav_pcm16([0, 1, -1])
    assert wav[:4] == b"RIFF" and len(wav) == 44 + 6


if __name__ == "__main__":
    test_uploads_only_the_new_audio_and_joins_the_line()
    print("ok")
