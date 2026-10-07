"""
Server-side voice activity detection on 16 kHz PCM16 frames of 20 ms.

Two ways a learner turn ends, and the edge supports both:
  - the client says so (`end_turn`): the browser already runs Silero VAD (parle's client), and its decision wins;
  - the edge decides: `EnergyVad` below, an adaptive energy gate with hysteresis (speech starts after
    `START_FRAMES` loud frames, ends after `silence_ms` quiet ones). With `RT_SILERO_ONNX` pointing at a Silero v5 ONNX
    model and onnxruntime importable, a loud frame must also be voiced per Silero (probability ≥ 0.5) — this keeps
    keyboard clicks and door slams from opening a turn. Without it the energy gate alone runs (CPU: microseconds/frame).

The thresholds are engineering defaults to tune on class audio, not published values: -45 dBFS floor, 3× (≈ +10 dB) over
the running noise floor, 60 ms to open, 700 ms (RT_VAD_SILENCE_MS) of quiet to close — 700 ms sits inside the 500–1000 ms
end-of-turn silence most voice agents use and above the ~200 ms gaps inside a learner's hesitant A1 sentence.
"""

import os

import numpy as np

FRAME_SAMPLES = 320  # 20 ms at 16 kHz
START_FRAMES = 3
MIN_RMS = 10 ** (-45 / 20)
OVER_FLOOR = 3.0


class _Silero:
    """Optional Silero v5 gate (onnxruntime, 512-sample windows at 16 kHz)."""

    def __init__(self, path: str):
        import onnxruntime as ort  # noqa: PLC0415 — optional dependency

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros(64, dtype=np.float32)
        self.pending = np.zeros(0, dtype=np.float32)
        self.prob = 0.0

    def push(self, samples: np.ndarray) -> float:
        self.pending = np.concatenate([self.pending, samples])
        while len(self.pending) >= 512:
            chunk, self.pending = self.pending[:512], self.pending[512:]
            x = np.concatenate([self.context, chunk])[None, :]
            out, self.state = self.session.run(None, {"input": x, "state": self.state, "sr": np.array(16000, dtype=np.int64)})
            self.context = chunk[-64:]
            self.prob = float(out[0][0])
        return self.prob


def load_silero():
    path = os.environ.get("RT_SILERO_ONNX", "")
    if not path or not os.path.exists(path):
        return None
    try:
        return _Silero(path)
    except Exception as error:  # noqa: BLE001 — optional: fall back to the energy gate
        print(f"[edge] silero unavailable ({error!r}); energy VAD only", flush=True)
        return None


class EnergyVad:
    def __init__(self, silence_ms: int = 700, silero=None):
        self.silence_frames = max(5, silence_ms // 20)
        self.floor = MIN_RMS
        self.speaking = False
        self.loud_run = 0
        self.quiet_run = 0
        self.silero = silero

    def push(self, frame: np.ndarray) -> str | None:
        """One 20 ms float32 frame → "start" | "end" | None."""
        rms = float(np.sqrt(np.mean(frame * frame))) if len(frame) else 0.0
        threshold = max(MIN_RMS, self.floor * OVER_FLOOR)
        loud = rms > threshold
        if self.silero is not None:
            loud = loud and self.silero.push(frame) >= 0.5
        if not self.speaking:
            # The floor follows the room only while nobody speaks (slow up, fast down).
            self.floor = self.floor * 0.9 + rms * 0.1 if rms < self.floor else self.floor * 0.995 + rms * 0.005
            self.floor = max(self.floor, MIN_RMS / 4)
            self.loud_run = self.loud_run + 1 if loud else 0
            if self.loud_run >= START_FRAMES:
                self.speaking, self.quiet_run = True, 0
                return "start"
            return None
        self.quiet_run = 0 if loud else self.quiet_run + 1
        if self.quiet_run >= self.silence_frames:
            self.speaking, self.loud_run = False, 0
            return "end"
        return None
