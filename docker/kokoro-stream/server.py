import asyncio
import json
import os
import re
import struct
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import espeakng_loader
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from phonemizer.backend.espeak.wrapper import EspeakWrapper

if os.environ.get("ESPEAK_DATA"):
    espeakng_loader.get_data_path = lambda: os.environ["ESPEAK_DATA"]
    espeakng_loader.get_library_path = lambda: os.environ["ESPEAK_LIBRARY"]
EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())

from misaki import espeak  # noqa: E402

from normalize import normalize  # noqa: E402
from vowels import fix as fix_vowels  # noqa: E402
import pocket as pocket_engine  # noqa: E402

MODEL_DIR = Path(os.environ.get("KOKORO_STREAM_DIR", "/models/kokoro-stream"))
MODEL_REVISION = os.environ.get("KOKORO_STREAM_REVISION")
API_KEY = os.environ.get("KOKORO_API_KEY", "")
THREADS = int(os.environ.get("KOKORO_THREADS", "4"))
OPENING_THREADS = int(os.environ.get("KOKORO_OPENING_THREADS", str(2 * THREADS)))
LATER_THREADS = int(os.environ.get("KOKORO_LATER_THREADS", "2"))
MAX_PARALLEL = int(os.environ.get("KOKORO_MAX_PARALLEL", "8"))
RATE = 24_000
SAMPLES_PER_FRAME = 300
HAR_PER_FRAME = 60
FIRST_FRAMES = 36
CHUNK_FRAMES = 64
CONTEXT_FRAMES = 8
LEAD_SECONDS = 0.6
KEPT_PAUSE_FRAMES = 6
VOICE_LEVEL = 10 ** (-50 / 20)
ONSET_MARGIN_SAMPLES = 480
MAX_TOKENS = 510
MIN_SPEED = 0.25
MAX_SPEED = 4.0
FIRST_PIECE_CHARS = 100
LANGUAGES = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "i": "it", "p": "pt-br", "h": "hi"}
NUMBER_LANGUAGES = {"a": "en", "b": "en", "e": "es", "f": "fr", "i": "it", "p": "pt"}
PHRASE_END = set(",.;:!?…")
STRESS = "ˈˌ"
PHRASE_END_RATE = 1.25
EMPHASIS_RATE = 1.3
EMPHASIS_SEMITONES = 2.5
QUESTION_RISE_SEMITONES = 3.0
WARM_UP = {"a": "Hello, let us begin.", "b": "Hello, let us begin.", "e": "Hola, empecemos.", "f": "Bonjour, commençons.", "i": "Ciao, iniziamo.", "p": "Olá, vamos começar.", "h": "नमस्ते, शुरू करते हैं।"}


def providers(value: str) -> list[str]:
    return [p.strip() for p in value.split(",") if p.strip()]


PROVIDERS = providers(os.environ.get("KOKORO_PROVIDERS", "CPUExecutionProvider"))
if "CUDAExecutionProvider" in PROVIDERS and hasattr(ort, "preload_dlls"):
    ort.preload_dlls()


@dataclass
class Engine:
    front: ort.InferenceSession
    generator: ort.InferenceSession
    opening: ort.InferenceSession
    vocab: dict[str, int]
    voices: dict[str, np.ndarray]


def session(path: Path, threads: int) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return ort.InferenceSession(str(path), opts, providers=PROVIDERS)


def load(model_dir: Path) -> Engine:
    return Engine(
        front=session(model_dir / "front.onnx", THREADS),
        generator=session(model_dir / "generator_streaming.onnx", LATER_THREADS),
        opening=session(model_dir / "generator_streaming.onnx", OPENING_THREADS),
        vocab=json.loads((model_dir / "config.json").read_text())["vocab"],
        voices={p.stem: np.fromfile(p, dtype=np.float32).reshape(-1, 1, 256) for p in (model_dir / "voices").glob("*.bin") if p.stem[0] in LANGUAGES},
    )


engine: Engine | None = None
phonemizers: dict[str, espeak.EspeakG2P] = {}
slots = threading.BoundedSemaphore(MAX_PARALLEL)


def phonemize(text: str, voice: str) -> str:
    language = LANGUAGES[voice[0]]
    if language not in phonemizers:
        phonemizers[language] = espeak.EspeakG2P(language=language)
    phonemes = phonemizers[language](text)
    return fix_vowels(text, phonemes) if language == "pt-br" else phonemes


def pieces(text: str) -> list[str]:
    sentences = [s for s in re.split(r"(?<=[.!?…])\s+", text.strip()) if s]
    if sentences and len(sentences[0]) > FIRST_PIECE_CHARS:
        cut = re.search(r"[,;:]\s", sentences[0][20:])
        if cut:
            at = 20 + cut.end()
            sentences[:1] = [sentences[0][:at].strip(), sentences[0][at:].strip()]
    return sentences


def segments(text: str) -> list[tuple[str, int]]:
    parts = re.split(r"\[pause:(\d+)\]", text)
    return [(parts[i], int(parts[i + 1]) if i + 1 < len(parts) else 0) for i in range(0, len(parts), 2)]


def without_emphasis(text: str) -> tuple[str, list[str]]:
    return text.replace("*", ""), re.findall(r"\*([^*]+)\*", text)


def spoken(text: str, voice: str) -> str:
    language = NUMBER_LANGUAGES.get(voice[0])
    return normalize(text, language) if language else text


def spoken_segments(text: str, voice: str) -> list[tuple[str, list[str], int]]:
    said = []
    for segment, pause_ms in segments(text):
        plain, emphasis = without_emphasis(segment)
        said.append((spoken(plain, voice), [spoken(word, voice) for word in emphasis], pause_ms))
    return said


def speed_of(value) -> float | None:
    try:
        speed = float(value or 1)
    except (TypeError, ValueError):
        return None
    return speed if MIN_SPEED <= speed <= MAX_SPEED else None


def word_spans(chars: list[str]) -> list[tuple[int, int]]:
    spans, start = [], 0
    for i, c in enumerate(chars + [" "]):
        if c == " ":
            if i > start:
                spans.append((start, i))
            start = i + 1
    return spans


def find_span(chars: list[str], target: str) -> tuple[int, int] | None:
    bare = [(i, c) for i, c in enumerate(chars) if c not in STRESS]
    wanted = [c for c in target if c not in STRESS and c not in PHRASE_END]
    text = "".join(c for _, c in bare)
    at = text.find("".join(wanted)) if wanted else -1
    if at < 0:
        return None
    return bare[at][0], bare[at + len(wanted) - 1][0] + 1


def controls(chars: list[str], emphasis: list[str]) -> tuple[np.ndarray, np.ndarray]:
    rate = np.ones(len(chars) + 2, dtype=np.float32)
    semitones = np.zeros(len(chars) + 2, dtype=np.float32)
    for start, end in word_spans(chars):
        marks = end
        while marks > start and chars[marks - 1] in PHRASE_END:
            marks -= 1
        if marks == end or marks == start:
            continue
        rate[1 + start : 1 + marks] = PHRASE_END_RATE
        if "?" in chars[marks:end]:
            semitones[1 + start : 1 + marks] += np.linspace(0, QUESTION_RISE_SEMITONES, marks - start, dtype=np.float32)
    for target in emphasis:
        span = find_span(chars, target)
        if span:
            word = slice(1 + span[0], 1 + span[1])
            rate[word] = np.maximum(rate[word], EMPHASIS_RATE)
            semitones[word] += EMPHASIS_SEMITONES
    return rate, semitones


def from_voice(samples: np.ndarray) -> np.ndarray:
    level = np.sqrt(np.convolve(samples**2, np.ones(240) / 240, "same"))
    loud = np.flatnonzero(level > VOICE_LEVEL)
    return samples[max(int(loud[0]) - ONSET_MARGIN_SAMPLES, 0) :] if len(loud) else samples


def to_pcm(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def speak(e: Engine, said: list[tuple[str, list[str], int]], voice: str, speed: float):
    pack = e.voices[voice]
    started = None
    produced = 0
    for plain, emphasis, pause_ms in said:
        emphasis_ps = [phonemize(word, voice) for word in emphasis]
        for piece in pieces(plain):
            chars = [p for p in phonemize(piece, voice) if p in e.vocab][:MAX_TOKENS]
            if not chars:
                continue
            ids = [e.vocab[c] for c in chars]
            rate, semitones = controls(chars, emphasis_ps)
            ref_s = pack[len(ids) - 1]
            x, har, durations = e.front.run(None, {"input_ids": np.array([[0, *ids, 0]], dtype=np.int64), "ref_s": ref_s, "speed": np.array([speed], dtype=np.float32), "token_rate": rate, "token_semitones": semitones})
            style = ref_s[:, :128]
            frames = x.shape[2]
            at = first = min(2 * max(int(durations[0]) - KEPT_PAUSE_FRAMES, 0), frames)
            while at < frames:
                if started is not None:
                    ahead = produced / RATE - (time.perf_counter() - started)
                    if ahead > LEAD_SECONDS:
                        time.sleep(ahead - LEAD_SECONDS)
                end = min(at + (FIRST_FRAMES if at == first else CHUNK_FRAMES), frames)
                lo, hi = max(at - CONTEXT_FRAMES, 0), min(end + CONTEXT_FRAMES, frames)
                audio = (e.opening if at == first else e.generator).run(None, {"x": x[:, :, lo:hi], "style": style, "har": har[:, :, lo * HAR_PER_FRAME : hi * HAR_PER_FRAME + 1]})[0]
                chunk = audio[(at - lo) * SAMPLES_PER_FRAME : (end - lo) * SAMPLES_PER_FRAME]
                if at == first:
                    chunk = from_voice(chunk)
                yield to_pcm(chunk)
                started = started or time.perf_counter()
                produced += len(chunk)
                at = end
        if pause_ms:
            silence = np.zeros(int(RATE * pause_ms / 1000), dtype=np.float32)
            yield to_pcm(silence)
            started = started or time.perf_counter()
            produced += len(silence)


def wav_header(rate: int = RATE) -> bytes:
    return b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", 0xFFFFFFFF)


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global engine
    pocket.preload()
    loaded = load(MODEL_DIR)
    for voice in sorted(loaded.voices):
        b"".join(speak(loaded, spoken_segments(WARM_UP[voice[0]], voice), voice, 1.0))
    engine = loaded
    yield


pocket = pocket_engine.Pocket.from_env()
app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    if engine is None:
        return error(503, "loading", "kokoro is loading")
    providers = {name: getattr(engine, name).get_providers()[0] for name in ("front", "generator", "opening")}
    extra = {"pocket": pocket.health()} if pocket.enabled else {}
    return {"status": "ok", "voices": sorted(engine.voices), "providers": providers, "revision": MODEL_REVISION, **extra}


@app.post("/v1/audio/speech")
async def speech(request: Request):
    if API_KEY and request.headers.get("authorization") != f"Bearer {API_KEY}":
        return error(401, "unauthorized", "missing or wrong API key")
    body = await request.json()
    if str(body.get("model") or "") in pocket_engine.MODELS:
        return await pocket_speech(body)
    if engine is None:
        return error(503, "loading", "kokoro is loading")
    text = str(body.get("input") or "").strip()
    voice = str(body.get("voice") or "")
    fmt = body.get("response_format") or "pcm"
    if not text:
        return error(400, "invalid_input", "input is empty")
    if voice not in engine.voices:
        return error(400, "invalid_voice", f"voice must be one of {', '.join(sorted(engine.voices))}")
    if fmt not in ("pcm", "wav"):
        return error(400, "invalid_response_format", "response_format must be pcm or wav")
    speed = speed_of(body.get("speed"))
    if speed is None:
        return error(400, "invalid_speed", f"speed must be a number from {MIN_SPEED} to {MAX_SPEED}")
    try:
        said = spoken_segments(text, voice)
    except OverflowError:
        return error(400, "invalid_input", "input has a number too large to read aloud")
    if not slots.acquire(blocking=False):
        return error(503, "busy", "all synthesis slots are in use")

    def stream():
        try:
            if fmt == "wav":
                yield wav_header()
            yield from speak(engine, said, voice, speed)
        finally:
            slots.release()

    return StreamingResponse(stream(), media_type=f"audio/{fmt};rate={RATE}")


def pocket_text(text: str, lang: str) -> str:
    """Kokoro's markup off (`[pause:ms]`, `*emphasis*`), numbers and units written out where normalize.py knows the language."""
    plain = re.sub(r"\s+", " ", re.sub(r"\[pause:\d+\]", " ", text).replace("*", "")).strip()
    return normalize(plain, lang) if lang in NUMBER_LANGUAGES.values() else plain


async def pocket_speech(body: dict):
    """`"model": "pocket"`: Pocket TTS (pocket.py). Refused before any audio when it cannot answer."""
    if not pocket.enabled:
        return error(400, "invalid_model", "Pocket TTS is off on this server (POCKET_TTS=1 turns it on)")
    text = str(body.get("input") or "").strip()
    voice = str(body.get("voice") or "")
    fmt = body.get("response_format") or "pcm"
    if not text:
        return error(400, "invalid_input", "input is empty")
    voices = pocket.voices()
    if voice not in voices:
        return error(400, "invalid_voice", f"voice must be one of {', '.join(sorted(voices))}")
    lang = pocket_engine.language_code(body.get("language")) if body.get("language") else voices[voice]
    if not lang:
        return error(400, "invalid_language", f"language must be one of {', '.join(sorted(pocket_engine.LANGUAGES))}")
    if fmt not in ("pcm", "wav"):
        return error(400, "invalid_response_format", "response_format must be pcm or wav")
    if speed_of(body.get("speed")) is None:
        return error(400, "invalid_speed", f"speed must be a number from {MIN_SPEED} to {MAX_SPEED}")
    try:
        said = pocket_text(text, lang)
    except OverflowError:
        return error(400, "invalid_input", "input has a number too large to read aloud")
    if pocket.model(lang) is None:
        return error(503, "loading", f"pocket {lang} is loading")
    if not await asyncio.to_thread(pocket.acquire, lang):
        return error(503, "busy", f"pocket {lang} is speaking another sentence")
    try:
        await asyncio.to_thread(pocket.voice_state, lang, voice)
    except Exception as err:  # noqa: BLE001 — a voice that cannot be fetched is the request's problem, not a crash
        pocket.release(lang)
        return error(503, "voice_unavailable", f"pocket voice {voice} for {lang}: {str(err)[:160]}")
    rate = pocket.rate(lang)
    stop = threading.Event()

    def stream():
        try:
            if fmt == "wav":
                yield wav_header(rate)
            yield from pocket.speak(lang, voice, said, stop)
        finally:
            stop.set()
            pocket.release(lang)

    return StreamingResponse(stream(), media_type=f"audio/{fmt};rate={rate}")
