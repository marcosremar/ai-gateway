import asyncio
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np

src = Path(__file__).with_name("server.py").read_text()
synthesized: list[str] = []
OPENERS = ["Hum, deixa eu ver.", "Só um instante."]
OPENER = np.full(4800, 1000, dtype=np.int16).tobytes()
REPLY = bytes(960)


async def tts_stream(text, language, voice, out):
    synthesized.append(text)
    await asyncio.sleep(0.02)
    if voice.get("fails"):
        raise RuntimeError("tts down")
    await out.put(bytes(480) + OPENER)
    await out.put(None)


ns: dict = {"asyncio": asyncio, "hashlib": hashlib, "json": json, "os": os, "np": np, "tts_stream": tts_stream,
            "LANGUAGE": {"pt": "Portuguese"}}
os.environ.update(FIRST_AUDIO_DEADLINE_MS="400", FIRST_AUDIO_MARGIN_MS="100")
exec(src[src.index("MAX_FIRST_AUDIO_DEADLINE_MS ="):src.index('@app.post("/v1/s2s")')], ns)
VOICE = {"audio": "ref.wav", "text": "Olá."}


async def turn(cfg: dict, reply_after: float, voice: dict = VOICE, cancel_after: float | None = None) -> tuple[list, dict, list[float]]:
    t0 = time.perf_counter()
    ms = lambda: round((time.perf_counter() - t0) * 1000)  # noqa: E731
    state: dict = {}

    async def reply():
        await asyncio.sleep(reply_after)
        if state["first_sound_ms"] is None:
            state["first_sound_ms"] = ms()
        yield {"type": "first_audio"}
        yield REPLY
        yield {"type": "done", **state}

    out, at = [], []
    frames = ns["first_audio_deadline"](reply(), state, cfg, voice, "pt", ms, lambda e: e, lambda chunk: chunk)

    async def read():
        async for item in frames:
            out.append(item)
            at.append(ms())

    reader = asyncio.create_task(read())
    if cancel_after is None:
        await reader
    else:
        await asyncio.sleep(cancel_after)
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        await frames.aclose()
    return out, state, at


def kinds(out: list) -> list[str]:
    return ["audio" if isinstance(item, bytes) else item["type"] + (":" + item["state"] if "state" in item else "") for item in out]


async def main() -> None:
    cfg = {"opener": {"lines": OPENERS}, "messages": []}
    out, state, _ = await turn(cfg, 0.05)
    assert kinds(out) == ["first_audio", "audio", "done"], kinds(out)
    assert (state["opener"], state["deadline_missed"], state["deadline_ms"]) == (None, False, 400), state
    assert sorted(synthesized) == sorted(OPENERS), synthesized

    out, state, at = await turn(cfg, 0.6)
    assert kinds(out) == ["opener:start", "audio", "opener:end", "first_audio", "audio", "done"], kinds(out)
    assert out[1] == bytes(480) + OPENER and out[4] == REPLY, "the opener is trimmed to 10 ms of lead, then the reply, no overlap"
    assert out[0] == {"type": "opener", "state": "start", "text": OPENERS[0], "index": 0, "audio_ms": 210, "at_ms": state["first_sound_ms"]}
    assert 280 <= at[0] <= 380, at
    assert out[-1]["opener"] == OPENERS[0] and out[-1]["deadline_missed"] is False and out[-1]["first_sound_ms"] < 400, out[-1]
    assert len(synthesized) == 2, "the second turn with the same voice and lines synthesizes nothing"

    out, state, at = await turn({**cfg, "endpoint_ms": 200}, 0.6)
    assert 80 <= at[0] <= 180 and state["endpoint_ms"] == 200, (at, state)

    out, state, _ = await turn({**cfg, "messages": [{"role": "user"}, {"role": "assistant"}]}, 0.6)
    assert out[0]["index"] == 1 and out[0]["text"] == OPENERS[1], "the line rotates with the turn"

    out, state, at = await turn({"messages": []}, 0.6)
    assert kinds(out) == ["deadline_missed", "first_audio", "audio", "done"], kinds(out)
    assert out[0]["deadline_ms"] == 400 and 390 <= at[0] <= 480 and out[-1]["deadline_missed"] is True and out[-1]["opener"] is None, (out, at)

    out, state, _ = await turn({**cfg, "first_audio_deadline_ms": 9000}, 0.05)
    assert state["deadline_ms"] == 2500, state

    out, state, _ = await turn(cfg, 5.0, cancel_after=0.35)
    assert kinds(out) == ["opener:start", "audio", "opener:end"], kinds(out)
    assert len([t for t in asyncio.all_tasks() if t is not asyncio.current_task()]) == 0, "a cancelled turn leaves no task"

    broken = {"audio": "other.wav", "text": "Olá.", "fails": True}
    out, state, _ = await turn(cfg, 0.6, voice=broken)
    assert kinds(out) == ["deadline_missed", "first_audio", "audio", "done"], kinds(out)
    assert not [k for k in ns["openers"] if k == ns["opener_key"](broken, "pt", OPENERS[0])], "a failed synthesis is not cached"

    for i in range(ns["MAX_OPENERS"] + 5):
        ns["warm_openers"]({"opener": {"lines": [f"linha {i}"]}}, VOICE, "pt")
    assert len(ns["openers"]) == ns["MAX_OPENERS"], "the cache is bounded"
    for task in list(ns["openers"].values()):
        task.cancel()
    await asyncio.sleep(0.05)


asyncio.run(main())
print("first audio deadline: ok")
