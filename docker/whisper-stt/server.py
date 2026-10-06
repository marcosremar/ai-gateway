"""Whisper large-v3 STT in one small container — the hear stage of speech-stack without LLM/TTS.

Batch:  POST /v1/audio/transcriptions  (multipart, OpenAI-compatible {text, language, duration, ms})
Stream: WS   /ws/audio-stream          (binary Int16 PCM 16 kHz in, {"text": <full transcript>} out)
Health: GET  /health → 503 {"stt": "loading"} until the model is warm, then 200 {"stt": "loaded"}.
        The gateway's HttpReplicaProbe reads that `stt` string and will not route to a cold replica.

Runs on CPU out of the box (int8 — local dev, cheap machines) and on CUDA when the libraries are present
(STT_DEVICE=cuda, STT_COMPUTE=float16). The same image serves both because the model bake is device-agnostic.

    docker build -f docker/whisper-stt/Dockerfile -t whisper-stt docker/
    docker run -p 8000:8000 whisper-stt
"""

import asyncio
import json
import os
import subprocess
import threading
import time

import numpy as np
from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from stt_batch import SttBatcher
from stt_stream import SttStream

STT_MODEL = os.environ.get("STT_MODEL", "large-v3")
STT_BEAM = int(os.environ.get("STT_BEAM", "1"))
STT_BATCH = int(os.environ.get("STT_BATCH", "4"))
STT_BATCH_WINDOW_MS = int(os.environ.get("STT_BATCH_WINDOW_MS", "25"))
STT_DEVICE = os.environ.get("STT_DEVICE", "auto")
STT_COMPUTE = os.environ.get("STT_COMPUTE", "auto")
STT_CPU_THREADS = int(os.environ.get("STT_CPU_THREADS", "0"))  # 0 = let ctranslate2 pick (physical cores)

app = FastAPI()
ready = {"ok": False, "stt": "loading", "detail": "starting"}
stt_batcher: SttBatcher | None = None


def pick_device() -> tuple[str, str]:
    if STT_DEVICE != "auto":
        device = STT_DEVICE
    else:
        try:
            import ctranslate2
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:  # noqa: BLE001 — no ctranslate2/cuda probe: safest is cpu
            device = "cpu"
    compute = STT_COMPUTE
    if compute == "auto":
        compute = "float16" if device == "cuda" else "int8"
    return device, compute


def decode_16k(data: bytes) -> np.ndarray:
    """Any container/codec → mono float32 16 kHz via ffmpeg (same rationale as speech-stack: no PyAV)."""
    out = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
                         input=data, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


def load() -> None:
    """Load the model and run a warm decode in a thread so /health can answer 503 while loading."""
    global stt_batcher
    try:
        from faster_whisper import WhisperModel
        device, compute = pick_device()
        model = WhisperModel(STT_MODEL, device=device, compute_type=compute,
                             cpu_threads=STT_CPU_THREADS, num_workers=1)
        stt_batcher = SttBatcher(model, max_batch=STT_BATCH, window_ms=STT_BATCH_WINDOW_MS, beam=STT_BEAM)
        silence = np.zeros(16000, dtype=np.float32)  # first real request must not pay kernel/graph setup
        stt_batcher.transcribe(silence, "en")
        ready.update(ok=True, stt="loaded", detail=f"warm ({device}/{compute})")
        print(f"whisper-stt ready: {STT_MODEL} on {device}/{compute}", flush=True)
    except Exception as error:  # noqa: BLE001
        ready.update(ok=False, stt="failed", detail=repr(error)[:300])
        print(f"whisper-stt load failed: {error!r}", flush=True)


@app.on_event("startup")
async def startup() -> None:
    threading.Thread(target=load, name="stt-load", daemon=True).start()


@app.get("/health")
async def health():
    return JSONResponse(ready, status_code=200 if ready["ok"] else 503)


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...), language: str = Form(""), prompt: str = Form("")):
    if not ready["ok"]:
        return JSONResponse({"error": f"stt not ready: {ready['detail']}"}, status_code=503)
    started = time.perf_counter()
    heard = await asyncio.to_thread(stt_batcher.transcribe, decode_16k(await file.read()), language or None, prompt or None)
    return {**heard, "ms": round((time.perf_counter() - started) * 1000)}


@app.websocket("/ws/audio-stream")
async def audio_stream(ws: WebSocket, language: str = "", chunk_size: float = 1.0):
    """Real-time STT for the gateway's streaming router — same contract as speech-stack's /ws/audio-stream."""
    await ws.accept()
    if not ready["ok"]:
        await ws.close(code=1013, reason=ready.get("detail", "warming"))
        return
    session = SttStream(stt_batcher, language or None, chunk_seconds=chunk_size)
    closed = False

    async def send(msg: dict) -> None:
        if not closed:
            try:
                await ws.send_text(json.dumps(msg))
            except Exception:  # noqa: BLE001 — client gone
                pass

    async def decode_loop() -> None:
        while not closed:
            await asyncio.sleep(max(0.2, session.chunk_samples / (2 * 16000)))
            for msg in await asyncio.to_thread(session.tick):
                await send(msg)

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
                    if json.loads(message["text"]).get("type") == "flush":
                        for msg in await asyncio.to_thread(session.finish):
                            await send(msg)
                except (ValueError, AttributeError):
                    pass
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 — malformed frame or transport error: end the session, don't kill the app
        pass
    finally:
        closed = True
        decoder.cancel()
        for msg in await asyncio.to_thread(session.finish):
            await send(msg)
