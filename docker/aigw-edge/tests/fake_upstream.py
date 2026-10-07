"""
Deterministic stand-in for a speech replica's model container (no GPU, no model): the routes the edge calls, with fixed
latencies so the harness can check what the edge adds.

    GET  /health                    200
    GET  /v1/voices                 one catalog voice (br-m-08)
    POST /v1/audio/transcriptions   STT_MS later: the turn's `prompt` after "FAKE:" if given, else a fixed sentence;
                                    Whisper-shaped metadata (no_speech_prob, avg_logprob, compression_ratio)
    POST /v1/chat/completions       SSE: first token after LLM_TTFT_MS, then one word every LLM_TOKEN_MS
    POST /v1/audio/speech           raw PCM16 24 kHz: first bytes after TTS_TTFB_MS, 0.25 s of tone per word, sent at
                                    4× real time in 40 ms chunks
    WS   /ws/audio-stream           {"text": "parcial <n>"} per second of audio received
    POST /v1/s2s                    the same turn as one framed answer ([kind][u32 len][payload], E=JSON, A=PCM)

    python tests/fake_upstream.py --port 8900
"""

import argparse
import asyncio
import json
import math
import struct

import numpy as np
from aiohttp import web

STT_MS, LLM_TTFT_MS, LLM_TOKEN_MS, TTS_TTFB_MS = 80, 60, 15, 50
REPLY = "Bom dia! Claro, um pão francês sai já. Mais alguma coisa?"
HEARD = "Bom dia, eu queria um pão francês."
calls = {"stt": 0, "llm": 0, "tts": 0, "s2s": 0, "partials": 0, "last_llm_messages": None, "last_tts": None, "traces": {}}


@web.middleware
async def record_trace(request, handler):
    """Which trace ids reached which route (the edge forwards the session's traceparent)."""
    tp = request.headers.get("traceparent", "")
    if tp.count("-") == 3:
        calls["traces"].setdefault(tp.split("-")[1], []).append(request.path)
    return await handler(request)


def tone(seconds: float, rate: int = 24000, freq: float = 180.0) -> bytes:
    t = np.arange(int(seconds * rate)) / rate
    wave = 0.3 * np.sin(2 * math.pi * freq * t) + 0.1 * np.sin(2 * math.pi * freq * 2.5 * t)
    return (wave * 32767).astype(np.int16).tobytes()


async def health(_r):
    return web.json_response({"ok": True})


async def voices(_r):
    return web.json_response({"voices": [{"id": "br-m-08", "text": "Olá, eu sou o Seu Jorge.", "lang": "pt"}]})


async def transcriptions(request):
    form = await request.post()
    calls["stt"] += 1
    prompt = str(form.get("prompt") or "")
    await asyncio.sleep(STT_MS / 1000)
    text = prompt[5:] if prompt.startswith("FAKE:") else HEARD
    return web.json_response({"text": text, "language": "pt", "no_speech_prob": 0.01, "avg_logprob": -0.2,
                              "compression_ratio": 1.2, "ms": STT_MS})


async def chat(request):
    body = await request.json()
    calls["llm"] += 1
    calls["last_llm_messages"] = body.get("messages")
    res = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
    await res.prepare(request)
    await asyncio.sleep(LLM_TTFT_MS / 1000)
    for i, word in enumerate(REPLY.split(" ")):
        if i:
            await asyncio.sleep(LLM_TOKEN_MS / 1000)
        delta = {"choices": [{"delta": {"content": (" " if i else "") + word}}]}
        await res.write(f"data: {json.dumps(delta)}\n\n".encode())
    await res.write(b"data: [DONE]\n\n")
    return res


async def speech(request):
    body = await request.json()
    calls["tts"] += 1
    calls["last_tts"] = {k: body.get(k) for k in ("input", "voice", "ref_audio", "ref_text", "task_type", "language")}
    res = web.StreamResponse(headers={"Content-Type": "audio/pcm"})
    await res.prepare(request)
    await asyncio.sleep(TTS_TTFB_MS / 1000)
    pcm = tone(0.25 * max(1, len(body["input"].split())))
    step = int(0.04 * 24000) * 2
    for at in range(0, len(pcm), step):
        await res.write(pcm[at:at + step])
        await asyncio.sleep(0.01)
    return res


async def audio_stream(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    calls["partials"] += 1
    received, sent = 0, 0
    async for msg in ws:
        if msg.type == web.WSMsgType.BINARY:
            received += len(msg.data) // 2
            if received // 16000 > sent:
                sent = received // 16000
                await ws.send_str(json.dumps({"text": f"parcial {sent}"}))
    return ws


def frame(kind: bytes, payload: bytes) -> bytes:
    return kind + struct.pack(">I", len(payload)) + payload


async def s2s(request):
    form = await request.post()
    calls["s2s"] += 1
    cfg = json.loads(str(form.get("config") or "{}"))
    res = web.StreamResponse(headers={"Content-Type": "application/x-aigw-s2s"})
    await res.prepare(request)
    await asyncio.sleep(STT_MS / 1000)
    prompt = cfg.get("stt_prompt") or ""
    text = prompt[5:] if prompt.startswith("FAKE:") else HEARD
    await res.write(frame(b"E", json.dumps({"type": "transcript", "text": text, "stt_ms": STT_MS, "no_speech_prob": 0.01,
                                            "avg_logprob": -0.2, "compression_ratio": 1.2}).encode()))
    await asyncio.sleep(LLM_TTFT_MS / 1000)
    await res.write(frame(b"E", json.dumps({"type": "llm_first_token", "at_ms": STT_MS + LLM_TTFT_MS}).encode()))
    for sentence in ("Bom dia!", "Claro, um pão francês sai já.", "Mais alguma coisa?"):
        await res.write(frame(b"E", json.dumps({"type": "sentence", "text": sentence}).encode()))
        await asyncio.sleep(TTS_TTFB_MS / 1000)
        await res.write(frame(b"A", tone(0.25 * len(sentence.split()))))
    await res.write(frame(b"E", json.dumps({"type": "done", "reply": REPLY, "transcript": text}).encode()))
    return res


async def stats(_r):
    return web.json_response(calls)


def app() -> web.Application:
    a = web.Application(client_max_size=50 << 20, middlewares=[record_trace])
    a.router.add_get("/health", health)
    a.router.add_get("/v1/voices", voices)
    a.router.add_post("/v1/audio/transcriptions", transcriptions)
    a.router.add_post("/v1/chat/completions", chat)
    a.router.add_post("/v1/audio/speech", speech)
    a.router.add_get("/ws/audio-stream", audio_stream)
    a.router.add_post("/v1/s2s", s2s)
    a.router.add_get("/__stats", stats)
    return a


if __name__ == "__main__":
    import logging

    # The edge cancels LLM/TTS calls on barge-in: the resulting "cannot write to closing transport" is expected here.
    logging.getLogger("aiohttp.server").setLevel(logging.CRITICAL)
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8900)
    web.run_app(app(), host="127.0.0.1", port=parser.parse_args().port, access_log=None, print=None)
