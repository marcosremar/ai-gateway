"""Unit test of the per-sentence TTS stream (no GPU): python3 docker/speech-stack/test_tts_stream.py"""
import asyncio
import math
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np

src = Path(__file__).with_name("server.py").read_text()


class CutResponse:
    status_code = 200

    async def aiter_bytes(self):
        yield b"\0" * 480
        raise RuntimeError("peer closed connection without sending complete message body")


class Client:
    @asynccontextmanager
    async def stream(self, *_args, **_kwargs):
        yield CutResponse()


ns: dict = {"asyncio": asyncio, "math": math, "time": time, "uuid": uuid, "np": np, "TTS_FRAMES_PER_SECOND": 12.5,
            "client": Client(), "TTS_URL": "", "TTS_MODEL": "tts", "SAMPLE_RATE": 24000, "TTS_MAX_SECONDS": 3.0,
            "TTS_MAX_SECONDS_PER_CHAR": 0.2, "TTS_MAX_LEAD_SECONDS": 1.0, "TTS_SILENCE_RMS": 300, "TTS_OVERLONG_RATIO": 0.9}
exec(src[src.index("def silent"):src.index("LANGUAGE =")], ns)
QUIET, LOUD = b"\0" * 23000 + b"\0\x04" * 500, b"\0\x10" * 12000


async def run() -> tuple[list, BaseException | None, int | None]:
    out: asyncio.Queue = asyncio.Queue()
    raised = retries = None
    try:
        retries = await ns["tts_stream"]("Oi.", "Portuguese", {"audio": "a", "text": "t"}, out)
    except RuntimeError as error:
        raised = error
    return [out.get_nowait() for _ in range(out.qsize())], raised, retries


def serve(*streams):
    left, bodies = list(streams), []

    class Response:
        status_code = 200

        def __init__(self, chunks):
            self.chunks = chunks

        async def aiter_bytes(self):
            for chunk in self.chunks:
                if isinstance(chunk, Exception):
                    raise chunk
                yield chunk

    @asynccontextmanager
    async def stream(*_args, **kwargs):
        bodies.append(dict(kwargs["json"]))
        yield Response(left.pop(0))

    ns["client"].stream = stream
    return bodies


items, raised, _ = asyncio.run(run())
assert raised is not None, "a cut stream must still raise (warm-up depends on it)"
assert items == [b"\0" * 480, b"\0" * 480, raised, None], items

bodies = serve([QUIET, QUIET, LOUD, QUIET])
items, raised, retries = asyncio.run(run())
assert raised is None and retries == 0 and items == [QUIET, QUIET, LOUD, QUIET, None], (raised, retries, len(items))
assert bodies[0]["max_new_tokens"] == 45 and len(bodies[0]["extra_params"]["request_id"]) == 12, bodies[0]

bodies = serve([QUIET, QUIET, QUIET, QUIET, QUIET], [QUIET, LOUD])
items, raised, retries = asyncio.run(run())
assert raised is None and retries == 1 and items == [QUIET, QUIET, LOUD, None], (raised, retries, len(items))
assert bodies[0]["extra_params"] != bodies[1]["extra_params"]

serve([QUIET, RuntimeError("peer closed")], [LOUD, QUIET])
items, raised, retries = asyncio.run(run())
assert raised is None and retries == 1 and items == [QUIET, LOUD, QUIET, None], (raised, retries, len(items))

serve([LOUD, RuntimeError("peer closed")])
items, raised, _ = asyncio.run(run())
assert raised is not None and items == [LOUD, raised, None], items

serve([QUIET] * 8, [QUIET] * 8)
items, raised, _ = asyncio.run(run())
assert raised is not None and "runaway" in str(raised), raised
assert sum(len(item) for item in items if isinstance(item, bytes)) == 8 * 24000 and items[-2] is raised, len(items)
stats: dict = {}


async def run_long() -> tuple[list, BaseException | None]:
    out: asyncio.Queue = asyncio.Queue()
    raised = None
    try:
        await ns["tts_stream"]("Oi.", "Portuguese", {"audio": "a", "text": "t"}, out, stats)
    except RuntimeError as error:
        raised = error
    return [out.get_nowait() for _ in range(out.qsize())], raised


CAP = int(3.6 * 24000) * 2
serve([LOUD] * 8)
items, raised = asyncio.run(run_long())
assert raised is None and stats == {"tts_overlong": 1} and items[-1] is None, (raised, stats)
assert sum(len(item) for item in items[:-1]) == CAP, sum(len(item) for item in items[:-1])

serve([*[LOUD] * 7, RuntimeError("peer closed connection without sending complete message body")])
items, raised = asyncio.run(run_long())
assert raised is None and stats == {"tts_overlong": 2} and items == [*[LOUD] * 7, None], (raised, stats, len(items))

serve([LOUD, QUIET])
items, raised = asyncio.run(run_long())
assert raised is None and stats == {"tts_overlong": 2}, "a clean sentence is not counted"
print("ok: a heard sentence that runs to its cap (more audio than the cap, or the engine's stop at max_new_tokens) is cut "
      "there and counted, the turn goes on")
print("ok: a sentence silent for over a second or cut before any sound is asked again once and its silence is not played; "
      "a stream cut after sound, or a second runaway, reaches the speaker as an error before the end marker")
