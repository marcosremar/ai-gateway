"""One open sentence transcribed by repeated batch calls.

Each draft uploads only the audio since the previous draft, plus two seconds.
The final is not this: the caller sends the whole sentence once. A tail whose
overlap does not match is dropped and the next draft sends the whole sentence.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

DRAFT_OVERLAP_SAMPLES = 2 * 16_000


@dataclass(frozen=True)
class DraftPiece:
    start: int
    continued: bool


class GrowingUtterance:
    def __init__(self) -> None:
        self.covered = 0
        self.hypothesis = ""

    def reset(self) -> None:
        self.covered = 0
        self.hypothesis = ""

    def piece(self, heard: int) -> DraftPiece | None:
        """None when `heard` was already transcribed. A shorter buffer clears the cursor."""
        if self.covered > heard:
            self.reset()
        if self.hypothesis and heard <= self.covered:
            return None
        continued = self.covered > DRAFT_OVERLAP_SAMPLES and heard > self.covered
        start = self.covered - DRAFT_OVERLAP_SAMPLES if continued else 0
        return DraftPiece(start, continued)

    def accept(self, continued: bool, transcript: str, heard: int) -> str | None:
        """The whole line to show, or None when a continuation does not overlap."""
        if not continued:
            if not transcript.strip():
                return None
            self.hypothesis = transcript
            self.covered = heard
            return self.hypothesis
        line = join_overlap(self.hypothesis, transcript)
        if line is None:
            self.reset()
            return None
        self.hypothesis = line
        self.covered = heard
        return line


def wav_pcm16(samples) -> bytes:
    """16 kHz mono PCM16 WAV. `samples` are already in the int16 range."""
    data = b"".join(struct.pack("<h", max(-32768, min(32767, int(s)))) for s in samples)
    return struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(data), b"WAVE", b"fmt ", 16, 1, 1, 16_000, 32_000, 2, 16, b"data", len(data)) + data


def _bare(word: str) -> str:
    return "".join(c for c in word if c.isalnum()).lower()


def join_overlap(prev: str, new: str) -> str | None:
    prev_w = prev.split()
    new_w = new.split()
    if not prev_w:
        return new
    if not new_w:
        return prev
    limit = min(12, len(prev_w), len(new_w))
    for k in range(limit, 0, -1):
        tail = [_bare(w) for w in prev_w[-k:]]
        for skip in range(3):
            if skip + k > len(new_w):
                continue
            head = [_bare(w) for w in new_w[skip : skip + k]]
            if tail == head:
                rest = new_w[skip + k :]
                return prev if not rest else prev + " " + " ".join(rest)
    return None
