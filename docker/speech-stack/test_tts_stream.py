"""Unit test of the per-sentence TTS stream (no GPU): python3 docker/speech-stack/test_tts_stream.py"""
import asyncio
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


ns: dict = {"asyncio": asyncio, "client": Client(), "TTS_URL": "", "TTS_MODEL": "tts"}
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
print("ok: a TTS stream cut mid-sentence reaches the speaker as an error before the end marker")
