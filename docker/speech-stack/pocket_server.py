"""
Pocket TTS sidecar of the speech-stack: `python3 pocket_server.py [port]` on 127.0.0.1 (default 8093), started and
stopped by the orchestrator's TTS engine manager (server.py `PocketEngine`, tts_engines.py) — a process of its own so
stopping it gives all of Pocket's memory back, and so it runs on the base image's own Python with its CUDA torch
(the orchestrator's /opt/wenv has no torch and carries CUDA 12 libraries for faster-whisper).

`pocket.py` and `normalize.py` are the CPU voice server's (docker/kokoro-stream), vendored byte for byte
(test_pocket_vendored.py). Same request as that server's `"model": "pocket"`:

POST /v1/audio/speech  {"input", "voice", "language", "response_format": "pcm"|"wav", "speed"}
    → s16le mono 24 kHz (pcm) or a streaming WAV, from the first chunk. A voice Pocket does not know (a Qwen3 preset,
      a cast id) speaks with the language's own voice (masculine for an `xx-m-…` id or a masculine Qwen3 preset).
    → 503 `loading` while the language loads (it starts loading), 503 `busy` when it speaks another sentence.
GET  /health  → {"status": "ok", "pocket": {languages, idle_unload_s}} as soon as the process is up.

Env: POCKET_PRELOAD (languages loaded at start, default none), POCKET_IDLE_UNLOAD_S (900), POCKET_THREADS (4),
POCKET_DEVICE (cpu; `cuda` is experimental), POCKET_WAIT_S (2).
"""

from __future__ import annotations

import asyncio
import os
import re
import struct
import sys
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

import pocket as pocket_engine
from normalize import normalize

NUMBER_LANGUAGES = {"en", "es", "fr", "it", "pt"}
MASCULINE_PRESETS = {"ryan", "aiden", "dylan", "eric", "uncle_fu"}
MIN_SPEED, MAX_SPEED = 0.5, 2.0

pocket = pocket_engine.Pocket.from_env({**os.environ, "POCKET_TTS": "1"})


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, "type": "upstream_error" if status >= 500 else "invalid_request_error"}},
                        status_code=status)


def wav_header(rate: int) -> bytes:
    return (b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
            + b"data" + struct.pack("<I", 0xFFFFFFFF))


def voice_for(voice: str, lang: str) -> str:
    """The asked voice when Pocket has it, else the language's own voice of the same gender."""
    if voice in pocket_engine.VOICES:
        return voice
    masculine = bool(re.match(r"^[a-z]{2}-m-", voice, re.I)) or voice.lower() in MASCULINE_PRESETS
    masc, fem = pocket_engine.DEFAULT_VOICES[lang]
    return masc if masculine else fem


def spoken_text(text: str, lang: str) -> str:
    """Kokoro's markup off (`[pause:ms]`, `*emphasis*`), numbers and units written out where normalize.py knows the language."""
    plain = re.sub(r"\s+", " ", re.sub(r"\[pause:\d+\]", " ", text).replace("*", "")).strip()
    return normalize(plain, lang) if lang in NUMBER_LANGUAGES else plain


@asynccontextmanager
async def lifespan(_: FastAPI):
    pocket.preload()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok", "pocket": pocket.health()}


@app.post("/v1/audio/speech")
async def speech(request: Request):
    try:
        body = await request.json()
    except ValueError:
        return error(400, "invalid_json", "body must be JSON")
    if not isinstance(body, dict):
        return error(400, "invalid_json", "body must be a JSON object")
    text = str(body.get("input") or "").strip()
    voice = str(body.get("voice") or "")
    fmt = body.get("response_format") or "pcm"
    if not text:
        return error(400, "invalid_input", "input is empty")
    lang = pocket_engine.language_code(body.get("language")) if body.get("language") else pocket_engine.VOICES.get(voice)
    if not lang:
        return error(400, "invalid_language", f"language must be one of {', '.join(sorted(pocket_engine.LANGUAGES))}")
    if fmt not in ("pcm", "wav"):
        return error(400, "invalid_response_format", "response_format must be pcm or wav")
    try:
        speed = float(body.get("speed") or 1.0)
    except (TypeError, ValueError):
        speed = -1
    if not MIN_SPEED <= speed <= MAX_SPEED:
        return error(400, "invalid_speed", f"speed must be a number from {MIN_SPEED} to {MAX_SPEED}")
    voice = voice_for(voice, lang)
    try:
        said = spoken_text(text, lang)
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

    return StreamingResponse(stream(), media_type=f"audio/{fmt};rate={rate}", headers={"X-Accel-Buffering": "no"})


if __name__ == "__main__":
    import uvicorn

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8093
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
