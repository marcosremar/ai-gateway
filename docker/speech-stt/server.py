"""Whisper large-v3, streaming, with the GPU to itself.

POST /v1/audio/transcriptions   OpenAI-shaped batch STT.
WS   /ws/audio-stream           PCM16 16 kHz in. Same query as the speech-stack: language, chunk_size, prompt,
                                segments, window, silence. Defaults are tighter than the shared image (chunk 0.5 s,
                                silence 0.4 s) so a final does not wait out a 1 s chunk plus 0.9 s of quiet.
GET  /health                    200 only after Whisper is loaded. 503 while it loads.
GET  /debug/gpu                 used / total / free MiB.
"""

import asyncio
import io
import json
import os
import struct
import subprocess
import time
import wave
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse
from faster_whisper import WhisperModel

from stt_batch import SttBatcher
from stt_stream import SttStream

STT_MODEL = os.environ.get("STT_MODEL", "large-v3")
STT_COMPUTE = os.environ.get("STT_COMPUTE", "float16")
STT_BEAM = int(os.environ.get("STT_BEAM", "1"))
STT_BATCH = int(os.environ.get("STT_BATCH", "4"))
STT_BATCH_WINDOW_MS = int(os.environ.get("STT_BATCH_WINDOW_MS", "25"))

app = FastAPI(lifespan=lambda app: boot_lifespan())
stt_batcher: SttBatcher | None = None
ready = {"ok": False, "detail": "starting"}


def wav_pcm16_16k(data: bytes) -> np.ndarray | None:
    try:
        with wave.open(io.BytesIO(data)) as clip:
            if (clip.getnchannels(), clip.getsampwidth(), clip.getframerate(), clip.getcomptype()) != (1, 2, 16000, "NONE"):
                return None
            frames = clip.readframes(clip.getnframes())
    except (wave.Error, EOFError, struct.error):
        return None
    if len(frames) < 2:
        return None
    return np.frombuffer(frames[: len(frames) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0


def decode_16k(data: bytes) -> np.ndarray:
    pcm = wav_pcm16_16k(data)
    if pcm is not None:
        return pcm
    out = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
        input=data, capture_output=True, check=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32)


def transcribe_sync(data: bytes, language: str | None, prompt: str | None) -> dict:
    if stt_batcher is None:
        raise RuntimeError("stt is still loading")
    started = time.perf_counter()
    audio = decode_16k(data)
    audio_ms = round((time.perf_counter() - started) * 1000)
    heard = stt_batcher.transcribe(audio, language or None, prompt or None)
    return {**heard, "audio_ms": audio_ms, "ms": round((time.perf_counter() - started) * 1000)}


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...), language: str = Form(""), prompt: str = Form("")):
    if stt_batcher is None:
        return JSONResponse({"error": {"message": "stt is loading", "type": "upstream_error", "code": "stt_loading"}}, status_code=503)
    return await asyncio.to_thread(transcribe_sync, await file.read(), language, prompt)


@app.websocket("/ws/audio-stream")
async def audio_stream(
    ws: WebSocket, language: str = "", chunk_size: float = 0.5, prompt: str = "", segments: int = 0,
    window: float = 12.0, silence: float = 0.4,
):
    await ws.accept()
    batcher = stt_batcher
    if batcher is None or not ready["ok"]:
        await ws.close(code=1013, reason=str(ready.get("detail", "warming"))[:120])
        return
    session = SttStream(
        batcher, language or None, chunk_seconds=chunk_size, window_seconds=window,
        silence_seconds=silence, prompt=prompt or None, segments=bool(segments),
    )
    closed = False

    async def send(msg: dict) -> None:
        if not closed:
            try:
                await ws.send_text(json.dumps(msg, ensure_ascii=False))
            except Exception:
                pass

    async def decode_loop() -> None:
        while not closed:
            await asyncio.sleep(max(0.2, session.chunk_samples / (2 * 16000)))
            for msg in await asyncio.to_thread(session.tick):
                await send(msg)

    if session.segments:
        await send({"type": "ready", "model": STT_MODEL, "language": session.language, "prompt_chars": len(session.prompt or "")})
    decoder = asyncio.create_task(decode_loop())
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                session.push(message["bytes"])
            elif message.get("text"):
                try:
                    control = json.loads(message["text"])
                except ValueError:
                    continue
                if not isinstance(control, dict):
                    continue
                if control.get("type") == "flush":
                    for msg in await asyncio.to_thread(session.finish):
                        await send(msg)
                elif control.get("type") == "config":
                    asked_prompt, asked_language = control.get("prompt"), control.get("language")
                    ack = session.configure(
                        prompt=asked_prompt if isinstance(asked_prompt, str) else None,
                        language=asked_language if isinstance(asked_language, str) else None,
                        clear_prompt="prompt" in control and asked_prompt is None,
                    )
                    if session.segments:
                        await send(ack)
    except WebSocketDisconnect:
        pass
    finally:
        closed = True
        decoder.cancel()


def gpu_memory() -> list[dict]:
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=5, check=True,
    ).stdout
    cards = [[int(value) for value in line.split(",")] for line in out.splitlines() if line.strip()]
    return [{"used_mb": used, "total_mb": total, "free_mb": total - used} for used, total in cards]


@app.get("/debug/gpu")
async def debug_gpu():
    return {"gpu": await asyncio.to_thread(gpu_memory)}


@app.get("/debug/logs")
async def debug_logs(tail: int = 80):
    return PlainTextResponse("")


@app.get("/health")
async def health():
    body = {
        "ok": ready["ok"], "detail": ready["detail"], "models": {"stt": STT_MODEL},
        "stt": stt_batcher.stats if stt_batcher else {},
    }
    return JSONResponse(body, status_code=200 if ready["ok"] else 503)


@asynccontextmanager
async def boot_lifespan():
    await boot()
    yield


def load_stt_sync() -> SttBatcher:
    model = WhisperModel(STT_MODEL, device="cuda", compute_type=STT_COMPUTE, num_workers=1)
    return SttBatcher(model, max_batch=STT_BATCH, window_ms=STT_BATCH_WINDOW_MS, beam=STT_BEAM)


async def boot() -> None:
    global stt_batcher
    try:
        ready["detail"] = "loading"
        batcher = await asyncio.to_thread(load_stt_sync)
        silence = np.zeros(16000, dtype=np.float32)
        await asyncio.gather(*[asyncio.to_thread(batcher.transcribe, silence, "pt") for _ in range(min(STT_BATCH, 2))])
        stt_batcher = batcher
        ready.update(ok=True, detail="warm")
        print("boot stt loaded", STT_MODEL, STT_COMPUTE, "beam", STT_BEAM, flush=True)
    except Exception as error:
        ready.update(ok=False, detail=repr(error)[:300])
        print("boot stt failed", repr(error)[:300], flush=True)
