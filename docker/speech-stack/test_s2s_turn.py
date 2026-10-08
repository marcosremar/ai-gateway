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
            "voices": {"v": {"audio": "a", "text": "t"}}, "turns": turns, "ready": {}}
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


def strict_llm(ctx, bytes_per_token, seen):
    async def stream(messages, max_tokens, *_args, **_kwargs):
        prompt = sum(4 + math.ceil(len(m["content"].encode()) / bytes_per_token) for m in messages)
        if prompt + max_tokens > ctx:
            seen.append(None)
            raise RuntimeError(f"llm http 400: b'request ({prompt} tokens) exceeds the available context size ({ctx} tokens)'")
        seen.append(messages)
        yield "Bom dia! "
    return stream


def whole_pairs(messages):
    roles = [m["role"] for m in messages[1:] if m["role"] != "system"]
    return roles[0::2] == ["user"] * len(roles[0::2]) and roles[1::2] == ["assistant"] * len(roles[1::2]) and roles[-1] == "user"


async def turn(llm_stream, tts_stream, cfg=None):
    running.clear()
    ns["llm_stream"], ns["tts_stream"] = llm_stream, tts_stream
    request = SimpleNamespace(query_params={})
    body = await ns["s2s"](request, Upload(), json.dumps({"voice": "v", **(cfg or {})}))
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

    ns["S2S_DEADLINE_S"] = 5.0
    system = "Speak only Brazilian Portuguese. Plain text only, no emojis, no stage directions. Answer in about 6-8 words. " * 24
    persona = {"role": "system", "content": "Persona: Lúcia, 52 anos, dona da padaria da esquina."}
    learner = ["Bom dia, eu queria um pão francês, por favor.", "Quanto custa?", "Não entendi, pode repetir mais devagar?",
               "Bonjour, je voudrais deux croissants et une baguette bien cuite, s'il vous plaît, et aussi un café crème."]
    clerk = ["Bom dia! O pão francês custa cinquenta centavos.", "Custa três reais e cinquenta.",
             "Claro. O pão custa cinquenta centavos. Você quer quantos pães? Hoje também tem pão de queijo quentinho e bolo de fubá."]
    history, seen = [persona], []
    for i in range(65):
        events, _ = await turn(strict_llm(2048, 3.6, seen), tts(), {"system": system, "messages": history})
        assert events[-1]["type"] == "done", (i, events[-1])
        history = history + [{"role": "user", "content": learner[i % 4]}, {"role": "assistant", "content": clerk[i % 3]}]
    assert None not in seen and len(seen) == 65, "the LLM never answers 400 in 65 turns"
    assert all(sent[0] == {"role": "system", "content": system} and persona in sent and whole_pairs(sent) for sent in seen)
    assert [m["content"] for m in seen[-1][-3:-1]] == [learner[63 % 4], clerk[63 % 3]], seen[-1][-3:]
    cuts = sum(a[:-1] != b[:len(a) - 1] for a, b in zip(seen, seen[1:]))
    assert 1 <= cuts <= 65 // ns["DROP_PAIRS"], cuts

    seen.clear()
    events, _ = await turn(strict_llm(2048, 1.2, seen), tts(), {"system": system[:1500], "messages": history[:25]})
    assert events[-1]["type"] == "done" and seen[0] is None and len(seen) == 2, (events[-1], seen[:1])
    assert seen[1][0]["content"] == system[:1500] and persona in seen[1] and whole_pairs(seen[1]) and len(seen[1]) < 27, len(seen[1])

    seen.clear()
    ns["ready"]["llm_ctx"] = 4096
    await turn(strict_llm(4096, 3.6, seen), tts(), {"system": system, "messages": history})
    assert len(seen) == 1 and len(seen[0]) > 60 and whole_pairs(seen[0]), len(seen[0])
    print(f"ok: 65 turns never overflow a 2048-token slot ({cuts} cuts of {ns['DROP_PAIRS']} pairs), a 400 for context is asked again "
          "with half the room, the slot size comes from /health's llm_ctx")


asyncio.run(main())
