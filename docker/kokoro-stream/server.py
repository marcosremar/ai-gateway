import json
import os
import re
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

if os.environ.get("ESPEAK_DATA"):
    import espeakng_loader

    espeakng_loader.get_data_path = lambda: os.environ["ESPEAK_DATA"]
    espeakng_loader.get_library_path = lambda: os.environ["ESPEAK_LIBRARY"]

from misaki import espeak  # noqa: E402

MODEL_DIR = Path(os.environ.get("KOKORO_STREAM_DIR", "/models/kokoro-stream"))
API_KEY = os.environ.get("KOKORO_API_KEY", "")
THREADS = int(os.environ.get("KOKORO_THREADS", "4"))
EXACT_THREADS = int(os.environ.get("KOKORO_EXACT_THREADS", "2"))
OPENING_THREADS = int(os.environ.get("KOKORO_OPENING_THREADS", str(2 * THREADS)))
MAX_PARALLEL = int(os.environ.get("KOKORO_MAX_PARALLEL", "4"))
RATE = 24_000
SAMPLES_PER_FRAME = 300
HAR_PER_FRAME = 60
FIRST_FRAMES = 36
CHUNK_FRAMES = 64
CONTEXT_FRAMES = 8
LEAD_SECONDS = 0.6
FADE_SAMPLES = 240
KEPT_PAUSE_FRAMES = 6
VOICE_LEVEL = 10 ** (-50 / 20)
ONSET_MARGIN_SAMPLES = 480
MAX_TOKENS = 510
FIRST_PIECE_CHARS = 100
LANGUAGES = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "i": "it", "p": "pt-br", "h": "hi"}
WARM_UP = {"a": "Hello, let us begin.", "b": "Hello, let us begin.", "e": "Hola, empecemos.", "f": "Bonjour, commençons.", "i": "Ciao, iniziamo.", "p": "Olá, vamos começar.", "h": "नमस्ते, शुरू करते हैं।"}


@dataclass
class Engine:
    front: ort.InferenceSession
    exact: ort.InferenceSession
    window: ort.InferenceSession
    opening: ort.InferenceSession
    vocab: dict[str, int]
    priors: dict[str, np.ndarray]
    voices: dict[str, np.ndarray]


def session(path: Path, threads: int) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])


def load(model_dir: Path) -> Engine:
    return Engine(
        front=session(model_dir / "front.onnx", THREADS),
        exact=session(model_dir / "generator.onnx", EXACT_THREADS),
        window=session(model_dir / "generator_window.onnx", THREADS),
        opening=session(model_dir / "generator_window.onnx", OPENING_THREADS),
        vocab=json.loads((model_dir / "config.json").read_text())["vocab"],
        priors=dict(np.load(model_dir / "priors.npz")),
        voices={p.stem: np.fromfile(p, dtype=np.float32).reshape(-1, 1, 256) for p in (model_dir / "voices").glob("*.bin") if p.stem[0] in LANGUAGES},
    )


engine: Engine | None = None
phonemizers: dict[str, espeak.EspeakG2P] = {}
background = ThreadPoolExecutor(max_workers=MAX_PARALLEL)
slots = threading.BoundedSemaphore(MAX_PARALLEL)


def phonemize(text: str, voice: str) -> str:
    language = LANGUAGES[voice[0]]
    if language not in phonemizers:
        phonemizers[language] = espeak.EspeakG2P(language=language)
    return phonemizers[language](text)


def pieces(text: str) -> list[str]:
    sentences = [s for s in re.split(r"(?<=[.!?…])\s+", text.strip()) if s]
    if sentences and len(sentences[0]) > FIRST_PIECE_CHARS:
        cut = re.search(r"[,;:]\s", sentences[0][20:])
        if cut:
            at = 20 + cut.end()
            sentences[:1] = [sentences[0][:at].strip(), sentences[0][at:].strip()]
    return sentences


def from_voice(samples: np.ndarray) -> np.ndarray:
    level = np.sqrt(np.convolve(samples**2, np.ones(240) / 240, "same"))
    loud = np.flatnonzero(level > VOICE_LEVEL)
    return samples[max(int(loud[0]) - ONSET_MARGIN_SAMPLES, 0) :] if len(loud) else samples


def to_pcm(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def crossfade(tail: np.ndarray | None, rest: np.ndarray) -> np.ndarray:
    n = min(len(tail), len(rest)) if tail is not None else 0
    if not n:
        return rest
    ramp = np.linspace(0, 1, n, dtype=np.float32)
    faded = rest.copy()
    faded[:n] = tail[:n] * (1 - ramp) + rest[:n] * ramp
    return faded


def speak(e: Engine, text: str, voice: str, speed: float):
    pack = e.voices[voice]
    means, variances = e.priors[voice] if voice in e.priors else (None, None)
    started = None
    produced = 0
    for piece in pieces(text):
        ids = [e.vocab[p] for p in phonemize(piece, voice) if p in e.vocab][:MAX_TOKENS]
        if not ids:
            continue
        ref_s = pack[len(ids) - 1]
        x, har, durations = e.front.run(None, {"input_ids": np.array([[0, *ids, 0]], dtype=np.int64), "ref_s": ref_s, "speed": np.array([speed], dtype=np.float32)})
        style = ref_s[:, :128]
        frames = x.shape[2]
        exact = lambda: background.submit(e.exact.run, None, {"x": x, "style": style, "har": har})
        whole = None
        at = first = min(2 * max(int(durations[0]) - KEPT_PAUSE_FRAMES, 0), frames)
        tail = None
        while means is not None and at < frames and not (whole and whole.done()):
            if started is not None:
                ahead = produced / RATE - (time.perf_counter() - started)
                if ahead > LEAD_SECONDS:
                    whole = whole or exact()
                    try:
                        whole.result(timeout=ahead - LEAD_SECONDS)
                    except TimeoutError:
                        pass
                    continue
            end = min(at + (FIRST_FRAMES if at == first else CHUNK_FRAMES), frames)
            lo, hi = max(at - CONTEXT_FRAMES, 0), min(end + CONTEXT_FRAMES, frames)
            audio = (e.opening if at == first else e.window).run(None, {"x": x[:, :, lo:hi], "style": style, "har": har[:, :, lo * HAR_PER_FRAME : hi * HAR_PER_FRAME + 1], "means": means, "variances": variances})[0]
            start, stop = (at - lo) * SAMPLES_PER_FRAME, (end - lo) * SAMPLES_PER_FRAME
            tail = audio[stop : stop + FADE_SAMPLES]
            chunk = from_voice(audio[start:stop]) if at == first else audio[start:stop]
            yield to_pcm(chunk)
            whole = whole or exact()
            started = started or time.perf_counter()
            produced += len(chunk)
            at = end
        whole = whole or exact()
        rest = crossfade(tail, whole.result()[0][at * SAMPLES_PER_FRAME :])
        if at == first:
            rest = from_voice(rest)
        if len(rest):
            yield to_pcm(rest)
            started = started or time.perf_counter()
            produced += len(rest)


def wav_header() -> bytes:
    return b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, RATE, RATE * 2, 2, 16) + b"data" + struct.pack("<I", 0xFFFFFFFF)


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global engine
    loaded = load(MODEL_DIR)
    for voice in sorted(loaded.voices):
        b"".join(speak(loaded, WARM_UP[voice[0]], voice, 1.0))
    engine = loaded
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    if engine is None:
        return error(503, "loading", "kokoro is loading")
    return {"status": "ok", "voices": sorted(engine.voices), "streaming": sorted(engine.priors)}


@app.post("/v1/audio/speech")
async def speech(request: Request):
    if API_KEY and request.headers.get("authorization") != f"Bearer {API_KEY}":
        return error(401, "unauthorized", "missing or wrong API key")
    if engine is None:
        return error(503, "loading", "kokoro is loading")
    body = await request.json()
    text = str(body.get("input") or "").strip()
    voice = str(body.get("voice") or "")
    fmt = body.get("response_format") or "pcm"
    if not text:
        return error(400, "invalid_input", "input is empty")
    if voice not in engine.voices:
        return error(400, "invalid_voice", f"voice must be one of {', '.join(sorted(engine.voices))}")
    if fmt not in ("pcm", "wav"):
        return error(400, "invalid_response_format", "response_format must be pcm or wav")
    if not slots.acquire(blocking=False):
        return error(503, "busy", "all synthesis slots are in use")

    def stream():
        try:
            if fmt == "wav":
                yield wav_header()
            yield from speak(engine, text, voice, float(body.get("speed") or 1))
        finally:
            slots.release()

    return StreamingResponse(stream(), media_type=f"audio/{fmt};rate={RATE}")
