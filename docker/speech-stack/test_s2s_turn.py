"""Unit test of one /v1/s2s turn with fake stages (no GPU): python3 docker/speech-stack/test_s2s_turn.py"""
import asyncio
import base64
import json
import os
import re
import struct
import time
from pathlib import Path
from types import SimpleNamespace

src = Path(__file__).with_name("server.py").read_text()


class App:
    def post(self, _path):
        return lambda fn: fn


class Upload:
    async def read(self):
        return b"wav"


ns: dict = {"asyncio": asyncio, "base64": base64, "json": json, "os": os, "re": re, "struct": struct, "time": time,
            "app": App(), "Request": object, "UploadFile": object, "File": lambda *_: None, "Form": lambda *_: None,
            "HTTPException": Exception, "StreamingResponse": lambda body, **_: body, "client": None, "TTS_URL": "",
            "LLM_URL": "", "TTS_MODEL": "tts", "FIRST_MIN_WORDS": 3, "MAX_CHUNK_CHARS": 160, "TTS_PARALLEL": 2, "SAMPLE_RATE": 24000,
            "TTS_MAX_SECONDS": 3.0, "TTS_MAX_SECONDS_PER_CHAR": 0.2, "voices": {"v": {"audio": "a", "text": "t"}}}
exec(src[src.index("SENTENCE_END ="):src.index("# ── Single-stage endpoints")], ns)
ns["transcribe_sync"] = lambda *_: {"text": "oi", "ms": 1}
REPLY = ["Bom dia! ", "Aqui está o pão. ", "Até logo, amiga."]
running: list[asyncio.Task] = []


def llm(tokens, fail_after=None, hang=False):
    async def stream(*_args, **_kwargs):
        for i, token in enumerate(tokens):
            if fail_after == i:
                raise RuntimeError("llm http 500")
            yield token
        if hang:
            await asyncio.sleep(60)
    return stream


def tts(fail_on=None, hang_on=None):
    async def stream(text, _language, _voice, out):
        running.append(asyncio.current_task())
        try:
            await out.put(b"\1\0" * 2400)
            if hang_on and hang_on in text:
                await asyncio.sleep(60)
            if fail_on and fail_on in text:
                error = RuntimeError("peer closed connection")
                await out.put(error)
                raise error
            await out.put(b"\1\0" * 2400)
        finally:
            await out.put(None)
    return stream


async def turn(llm_stream, tts_stream):
    running.clear()
    ns["llm_stream"], ns["tts_stream"] = llm_stream, tts_stream
    request = SimpleNamespace(query_params={})
    body = await ns["s2s"](request, Upload(), json.dumps({"voice": "v"}))
    events, audio = [], 0

    async def read():
        nonlocal audio
        async for chunk in body:
            if chunk[:1] == b"A":
                audio += len(chunk) - 5
            else:
                events.append(json.loads(chunk[5:]))
    await asyncio.wait_for(read(), 3)
    await asyncio.sleep(0.05)
    assert all(task.done() for task in running), "a finished turn leaves no synthesis running"
    return events, audio


async def main():
    events, _ = await turn(llm(REPLY), tts())
    assert events[-1]["type"] == "done", events[-1]

    for fail_after in (2, 0):
        events, _ = await turn(llm(REPLY, fail_after=fail_after), tts())
        assert events[-1]["type"] == "error" and "llm http 500" in events[-1]["message"], events[-1]
        assert "done" not in [e["type"] for e in events]

    events, _ = await turn(llm(REPLY), tts(fail_on="pão"))
    assert events[-1]["type"] == "error" and "peer closed" in events[-1]["message"], events[-1]
    print("ok: a failed LLM or TTS stream ends the turn with an in-band error and leaves nothing running")


asyncio.run(main())
