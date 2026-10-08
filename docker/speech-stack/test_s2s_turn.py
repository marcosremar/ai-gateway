"""Unit test of one /v1/s2s turn with fake stages (no GPU): python3 docker/speech-stack/test_s2s_turn.py"""
import asyncio
import base64
import json
import math
import os
import re
import struct
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

src = Path(__file__).with_name("server.py").read_text()


class App:
    def post(self, _path):
        return lambda fn: fn


class Upload:
    async def read(self):
        return b"wav"


turns = {"started": 0, "done": 0, "failed": {}, "stalled": {}}
ns: dict = {"asyncio": asyncio, "math": math, "uuid": uuid, "TTS_FRAMES_PER_SECOND": 12.5, "base64": base64, "json": json, "os": os, "re": re, "struct": struct, "time": time,
            "app": App(), "Request": object, "UploadFile": object, "File": lambda *_: None, "Form": lambda *_: None,
            "HTTPException": Exception, "StreamingResponse": lambda body, **_: body, "client": None, "TTS_URL": "",
            "LLM_URL": "", "TTS_MODEL": "tts", "FIRST_MIN_WORDS": 3, "MAX_CHUNK_CHARS": 160, "TTS_PARALLEL": 2, "SAMPLE_RATE": 24000,
            "S2S_MAX_GAP_S": 0.3, "S2S_DEADLINE_S": 5.0, "TTS_MAX_SECONDS": 3.0, "TTS_MAX_SECONDS_PER_CHAR": 0.2,
            "voices": {"v": {"audio": "a", "text": "t"}}, "turns": turns}
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
            return int(text.startswith("Bom"))
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
    events, audio = await turn(llm(REPLY), tts())
    done = events[-1]
    assert done["type"] == "done" and (done["sentences"], done["spoken"], done["skipped"], done["tts_retries"]) == (3, 3, 0, 1), done
    assert done["audio_ms"] == round(audio / 2 / 24000 * 1000) == 600, done

    events, _ = await turn(llm(REPLY, fail_after=2), tts())
    last = events[-1]
    assert (last["type"], last["stage"], last["code"]) == ("error", "llm", "stage_failed"), last
    assert "done" not in [e["type"] for e in events]

    events, _ = await turn(llm(REPLY, fail_after=0), tts())
    assert (events[-1]["type"], events[-1]["stage"]) == ("error", "llm"), events[-1]

    events, _ = await turn(llm(REPLY), tts(fail_on="pão"))
    last = events[-1]
    assert (last["type"], last["stage"], last["code"]) == ("error", "tts", "stage_failed"), last
    assert last["unspoken"] == "Até logo, amiga.", last

    events, _ = await turn(llm(REPLY), tts(hang_on="pão"))
    last = events[-1]
    assert (last["type"], last["stage"], last["code"]) == ("error", "tts", "upstream_stalled"), last

    events, _ = await turn(llm(REPLY[:1], hang=True), tts())
    assert (events[-1]["stage"], events[-1]["code"]) == ("llm", "upstream_stalled"), events[-1]

    ns["S2S_DEADLINE_S"] = 0.5

    async def slow(*_args, **_kwargs):
        for i in range(50):
            await asyncio.sleep(0.1)
            yield f"Palavra número {i}. "
    started = time.perf_counter()
    events, _ = await turn(slow, tts())
    assert events[-1]["code"] == "upstream_stalled" and time.perf_counter() - started < 1.5, events[-1]
    assert turns == {"started": 7, "done": 1, "failed": {"llm": 2, "tts": 1}, "stalled": {"tts": 1, "llm": 2}}, turns
    print("ok: a turn ends with done (with its sentence count) or an in-band error naming the stage, and never hangs")


asyncio.run(main())
