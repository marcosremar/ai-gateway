"""`WS /ws/audio-stream` end to end over Starlette's test client (no GPU, no faster-whisper):
python3 docker/speech-stack/test_audio_stream_ws.py — needs numpy, fastapi, httpx.
Closes 1013 while STT loads; the query prompt and {"type": "config"} frames reach every decode; segments=1 gives
ready → partial → final; the legacy shape stays {"text": …}."""
import asyncio
import json
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.testclient import TestClient

from stt_stream import SAMPLE_RATE, SttStream

FRAME = SAMPLE_RATE // 10
src = Path(__file__).with_name("server.py").read_text(encoding="utf-8")


def word(k: int, seconds: float = 0.5) -> bytes:
    return (np.full(int(seconds * SAMPLE_RATE), (0.05 + 0.01 * k) * 32768, dtype=np.float32)).astype("<i2").tobytes()


class Ear:
    def __init__(self):
        self.calls: list[dict] = []

    def transcribe(self, audio, language, prompt=None, partial=False):
        self.calls.append({"language": language, "prompt": prompt, "partial": partial})
        levels = [round((float(np.sqrt(np.mean(f * f))) - 0.05) / 0.01) if np.abs(f).max() > 0.02 else None
                  for f in audio[: len(audio) // FRAME * FRAME].reshape(-1, FRAME)]
        words, run, last = [], 0, None
        for level in levels + [None]:
            if level == last:
                run += 1
                continue
            if last is not None and run >= 3:
                words.append(f"w{last}")
            last, run = level, 1
        return {"text": " ".join(words), "language": language, "avg_logprob": -0.1}


app = FastAPI()
ear = Ear()
ns: dict = {"app": app, "WebSocket": WebSocket, "WebSocketDisconnect": WebSocketDisconnect, "SttStream": SttStream,
            "asyncio": asyncio, "json": json, "STT_MODEL": "large-v3", "stt_batcher": None,
            "ready": {"ok": False, "detail": "stt loading, llm waiting, tts warming"},
            "stages": {"stt": {"status": "loading"}, "llm": {"status": "waiting"}, "tts": {"status": "warming"}}}
exec(src[src.index('@app.websocket("/ws/audio-stream")'):src.index("def wants_stream(")], ns)
http = TestClient(app)


def until(ws, kind: str, limit: float = 5.0) -> dict:
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        msg = json.loads(ws.receive_text())
        if msg.get("type") == kind:
            return msg
    raise AssertionError(f"no {kind} within {limit} s")


# Loading: 1013 (try again later) with the boot state as the reason — the gateway hedges, the app falls back to batch.
with http.websocket_connect("/ws/audio-stream?language=pt&segments=1") as ws:
    try:
        ws.receive_text()
        raise AssertionError("the socket should close while STT loads")
    except WebSocketDisconnect as closed:
        assert closed.code == 1013 and "stt loading" in closed.reason, (closed.code, closed.reason)

ns["stt_batcher"] = ear
ns["stages"]["stt"]["status"] = "loaded"

with http.websocket_connect("/ws/audio-stream?language=pt&segments=1&chunk_size=0.5&prompt=Ksawery%20Wi%C5%9Bniewski") as ws:
    ready = json.loads(ws.receive_text())
    assert ready == {"type": "ready", "model": "large-v3", "language": "pt", "prompt_chars": 18}, ready
    ws.send_bytes(word(1) + word(2))
    partial = until(ws, "partial")
    assert partial["text"] == "w1 w2" and partial["utterance"] == 0, partial
    assert ear.calls[0]["prompt"] == "Ksawery Wiśniewski" and ear.calls[0]["language"] == "pt", ear.calls[0]
    long_vocabulary = ", ".join(f"Termo{i}" for i in range(300))  # ~2.6 KB: a slide's terms do not fit a URL
    ws.send_text(json.dumps({"type": "config", "prompt": long_vocabulary, "language": "fr"}))
    ack = until(ws, "config")
    assert ack == {"type": "config", "language": "fr", "prompt_chars": len(long_vocabulary)}, ack
    ws.send_bytes(word(3) + np.zeros(SAMPLE_RATE, dtype="<i2").tobytes())
    final = until(ws, "final")
    assert final["text"] == "w1 w2 w3" and final["reason"] == "silence" and final["utterance"] == 0, final
    assert ear.calls[-1]["prompt"] == long_vocabulary and ear.calls[-1]["language"] == "fr", ear.calls[-1]
    ws.send_bytes(word(4))
    ws.send_text(json.dumps({"type": "flush"}))
    flushed = until(ws, "final")
    assert flushed["text"] == "w4" and flushed["reason"] == "flush" and flushed["utterance"] == 1, flushed
    ws.send_text(json.dumps({"type": "config", "prompt": None}))
    assert until(ws, "config")["prompt_chars"] == 0
    ws.send_text("not json")  # ignored, the stream goes on
    ws.send_bytes(word(5) + np.zeros(SAMPLE_RATE, dtype="<i2").tobytes())
    assert until(ws, "final")["text"] == "w5" and ear.calls[-1]["prompt"] is None

# Legacy shape for the gateway's StreamingSTTRouter: no ready, {"text": the whole stream}.
with http.websocket_connect("/ws/audio-stream?language=pt&chunk_size=0.5") as ws:
    ws.send_bytes(word(1) + word(2))
    assert json.loads(ws.receive_text()) == {"text": "w1 w2"}
    ws.send_text(json.dumps({"type": "flush"}))
    assert json.loads(ws.receive_text()) == {"text": "w1 w2", "final": True}
print("audio-stream ws: ok — 1013 while loading, prompt by query and by config frame on every decode, segments events,"
      " flush, legacy shape")
