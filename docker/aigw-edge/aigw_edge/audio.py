"""
Per-frame audio work on the media path, in numpy instead of PyAV's resampler (profiled 2026-10-07 on the harness:
`AudioResampler.resample` 48 kHz stereo → 16 kHz mono cost ~0.35 ms per 20 ms frame and aiortc's pure-Python RFC 6465
audio level ~0.16 ms per outgoing frame — together a third of the edge's main-thread time per session).
"""

import ctypes
import ctypes.util
import fractions
import math
from pathlib import Path

import av
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


OPUS_RATE = 48000
OPUS_STEP = 120
OPUS_MAX_FRAME = 5760


def load_libopus():
    root = Path(av.__file__).parent
    bundled = [*root.glob(".dylibs/libopus*"), *root.parent.glob("av.libs/libopus*")]
    for path in [*map(str, bundled), ctypes.util.find_library("opus")]:
        try:
            lib = ctypes.CDLL(path)
            lib.opus_decoder_create.restype = ctypes.c_void_p
            lib.opus_decoder_destroy.argtypes = [ctypes.c_void_p]
            lib.opus_decode.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32, ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
            lib.opus_packet_has_lbrr.argtypes = [ctypes.c_char_p, ctypes.c_int32]
            lib.opus_packet_get_nb_samples.argtypes = [ctypes.c_char_p, ctypes.c_int32, ctypes.c_int32]
            return lib
        except (OSError, AttributeError, TypeError):
            continue
    return None


LIBOPUS = load_libopus()


def red_blocks(payload: bytes) -> list[tuple[int, bytes]]:
    try:
        headers, at = [], 0
        while payload[at] & 0x80:
            packed = int.from_bytes(payload[at + 1:at + 4], "big")
            headers.append((packed >> 10, packed & 0x3FF))
            at += 4
        at += 1
        blocks = []
        for offset, size in headers:
            blocks.append((offset, payload[at:at + size]))
            at += size
        return [*blocks, (0, payload[at:])]
    except IndexError:
        return []


NONE, FEC, RED = 0, 1, 2


class LossDecoder:
    def __init__(self, red: bool = False):
        self.dec = LIBOPUS.opus_decoder_create(OPUS_RATE, 1, ctypes.byref(ctypes.c_int()))
        self.pcm = (ctypes.c_int16 * (MAX_FILL_SAMPLES + OPUS_MAX_FRAME))()
        self.expected: int | None = None
        self.time_base = fractions.Fraction(1, OPUS_RATE)
        self.red = red

    def __del__(self):
        LIBOPUS.opus_decoder_destroy(self.dec)

    def frame(self, data: bytes, samples: int, fec: int, pts: int, loss: tuple) -> list:
        n = LIBOPUS.opus_decode(self.dec, data, len(data), self.pcm, samples, fec)
        if n <= 0:
            return []
        out = av.AudioFrame.from_ndarray(np.frombuffer(self.pcm, dtype=np.int16, count=n).reshape(1, -1), format="s16", layout="mono")
        out.sample_rate, out.pts, out.time_base, out.opaque = OPUS_RATE, pts, self.time_base, loss
        return [out]

    def packet(self, data: bytes, pts: int, spare: bool, kind: int) -> list:
        gap = 0 if self.expected is None else min(max(pts - self.expected, 0), MAX_FILL_SAMPLES)
        gap -= gap % OPUS_STEP
        lbrr = LIBOPUS.opus_packet_has_lbrr(data, len(data)) > 0
        size = max(LIBOPUS.opus_packet_get_nb_samples(data, len(data), OPUS_RATE), 0)
        concealed = self.frame(data, gap, 1, pts - gap, (gap, min(gap, size) if lbrr else 0, None)) if gap else []
        own = self.frame(data, OPUS_MAX_FRAME, 0, pts, (size, size, None) if spare else (0, 0, kind or (FEC if lbrr else NONE)))
        self.expected = pts + (own[0].samples if own else size)
        return concealed + own

    def decode(self, encoded) -> list:
        data, pts = encoded.data, encoded.timestamp
        if not data:
            return []
        if not self.red:
            return self.packet(data, pts, False, NONE)
        blocks = red_blocks(data)
        kind = RED if len(blocks) > 1 else NONE
        return [frame for offset, block in blocks
                if block and (not offset or (self.expected is not None and pts - offset >= self.expected))
                for frame in self.packet(block, pts - offset, bool(offset), kind)]


def is_red(codec) -> bool:
    return codec.mimeType.lower() == "audio/red"


def send_opus(sender) -> None:
    send = sender.send

    async def opus_first(parameters) -> None:
        parameters.codecs.sort(key=is_red)
        await send(parameters)

    sender.send = opus_first


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
    if LIBOPUS is None:
        return
    from aiortc import codecs, rtcpeerconnection  # noqa: PLC0415
    from aiortc.rtcrtpparameters import RTCRtpCodecParameters  # noqa: PLC0415

    rtp.DYNAMIC_PAYLOAD_TYPES = (*range(35, 64), *range(96, 128))
    codecs.CODECS["audio"][0].parameters = {"minptime": 10, "useinbandfec": 1}
    if not any(is_red(codec) for codec in codecs.CODECS["audio"]):
        codecs.CODECS["audio"].insert(1, RTCRtpCodecParameters(mimeType="audio/red", clockRate=48000, channels=2, payloadType=97))
    aiortc_common, aiortc_decoder = rtcpeerconnection.find_common_codecs, rtcrtpreceiver.get_decoder

    def common(local, remote):
        agreed = aiortc_common(local, remote)
        for codec in filter(is_red, agreed):
            codec.parameters = next((dict(c.parameters) for c in remote if c.payloadType == codec.payloadType), {})
        return agreed

    rtcpeerconnection.find_common_codecs = common
    rtcrtpreceiver.get_decoder = lambda codec: (
        LossDecoder(is_red(codec)) if is_red(codec) or codec.mimeType.lower() == "audio/opus" else aiortc_decoder(codec))
