"""Unit test of the per-sentence TTS stream (no GPU): python3 docker/speech-stack/test_tts_stream.py"""
import asyncio
import math
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

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


ns: dict = {"asyncio": asyncio, "math": math, "time": time, "uuid": uuid, "TTS_FRAMES_PER_SECOND": 12.5, "client": Client(), "TTS_URL": "", "TTS_MODEL": "tts", "SAMPLE_RATE": 24000,
            "TTS_MAX_SECONDS": 3.0, "TTS_MAX_SECONDS_PER_CHAR": 0.2}
exec(src[src.index("async def tts_stream"):src.index("LANGUAGE =")], ns)


async def run() -> tuple[list, BaseException | None]:
    out: asyncio.Queue = asyncio.Queue()
    raised = None
    try:
        await ns["tts_stream"]("Oi.", "Portuguese", {"audio": "a", "text": "t"}, out)
    except RuntimeError as error:
        raised = error
    return [out.get_nowait() for _ in range(out.qsize())], raised


items, raised = asyncio.run(run())
assert raised is not None, "a cut stream must still raise (warm-up depends on it)"
assert items[0] == b"\0" * 480 and items[1] is raised and items[2] is None and len(items) == 3, items


class RunawayResponse:
    status_code = 200

    async def aiter_bytes(self):
        while True:
            yield b"\0" * 48000


@asynccontextmanager
async def runaway(*_args, **_kwargs):
    yield RunawayResponse()

ns["client"].stream = runaway
items, raised = asyncio.run(run())
assert raised is not None and "runaway" in str(raised), raised
assert sum(len(item) for item in items if isinstance(item, bytes)) == 3 * 48000 and items[-2] is raised, len(items)
print("ok: a TTS stream cut mid-sentence reaches the speaker as an error before the end marker, and so does a runaway one")
