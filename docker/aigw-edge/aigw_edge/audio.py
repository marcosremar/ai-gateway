"""
Per-frame audio work on the media path, in numpy instead of PyAV's resampler (profiled 2026-10-07 on the harness:
`AudioResampler.resample` 48 kHz stereo → 16 kHz mono cost ~0.35 ms per 20 ms frame and aiortc's pure-Python RFC 6465
audio level ~0.16 ms per outgoing frame — together a third of the edge's main-thread time per session).
"""

import math

import numpy as np
from aiortc.jitterbuffer import JitterFrame

# 31-tap windowed-sinc low-pass at 7 kHz for 48 → 16 kHz (Nyquist 8 kHz): speech energy for STT stays below 7 kHz.
_TAPS = 31
_n = np.arange(_TAPS) - (_TAPS - 1) / 2
_LOWPASS = (np.sinc(2 * 7000 / 48000 * _n) * np.hamming(_TAPS)).astype(np.float32)
_LOWPASS /= _LOWPASS.sum()


class Downsampler48to16:
    """Decoded Opus (48 kHz, s16, mono or interleaved stereo) → PCM16 mono 16 kHz, filter state kept across frames."""

    def __init__(self):
        self.history = np.zeros(_TAPS - 1, dtype=np.float32)
        self.phase = 0

    def push(self, samples: np.ndarray, channels: int) -> bytes:
        x = samples.reshape(-1).astype(np.float32)
        if channels == 2:
            x = x.reshape(-1, 2).mean(axis=1)
        buf = np.concatenate([self.history, x])
        y = np.convolve(buf, _LOWPASS, mode="valid")  # len(x) outputs
        self.history = buf[-(_TAPS - 1):]
        out = y[self.phase::3]
        self.phase = (self.phase - len(y)) % 3
        return np.clip(out, -32768, 32767).astype(np.int16).tobytes()


def upsample2(x: np.ndarray, previous: int) -> np.ndarray:
    out = np.empty(len(x) * 2, dtype=np.int16)
    out[1::2] = x
    out[0::2] = (np.concatenate(([previous], x[:-1])).astype(np.int32) + x) // 2
    return out


MAX_FILL_SAMPLES = 48000


class GapFill:
    def __init__(self):
        self.expected: int | None = None

    def missing(self, pts: int, samples: int) -> int:
        gap = 0 if self.expected is None else min(max(pts - self.expected, 0), MAX_FILL_SAMPLES)
        self.expected = pts + samples
        return gap


class ArrivalOrder:
    def __init__(self):
        self.last: int | None = None

    def add(self, packet):
        if self.last is not None and (packet.sequence_number - self.last - 1) % 65536 >= 32768:
            return False, None
        self.last = packet.sequence_number
        return False, JitterFrame(data=packet._data, timestamp=packet.timestamp)


def audio_level_dbov(frame) -> int:
    """RFC 6465 Appendix A level (what aiortc puts in the ssrc-audio-level extension), vectorized."""
    pcm = np.frombuffer(bytes(frame.planes[0]), dtype=np.int16).astype(np.float32)
    if not len(pcm):
        return -127
    rms = math.sqrt(float(np.dot(pcm, pcm)) / (len(pcm) * 32767.0 * 32767.0))
    if rms <= 0:
        return -127
    return round(min(max(20 * math.log10(rms), -127), 0))


def install() -> None:
    from aiortc import rtcrtpreceiver, rtp  # noqa: PLC0415

    rtp.compute_audio_level_dbov = audio_level_dbov
    aiortc_buffer = rtcrtpreceiver.JitterBuffer
    rtcrtpreceiver.JitterBuffer = lambda capacity, prefetch=0, is_video=False: (
        aiortc_buffer(capacity, prefetch, is_video) if is_video else ArrivalOrder())
