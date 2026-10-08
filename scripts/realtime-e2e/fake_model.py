import argparse
import os
import sys
from pathlib import Path

from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "docker/aigw-edge/tests"))
import fake_upstream as fake  # noqa: E402

for name in ("STT_MS", "LLM_TTFT_MS", "LLM_TOKEN_MS", "TTS_TTFB_MS"):
    setattr(fake, name, int(os.environ.get(f"FAKE_{name}", getattr(fake, name))))
DROP_EVERY = int(os.environ.get("FAKE_TTS_DROP_EVERY", "0"))
DROP_MODE = os.environ.get("FAKE_TTS_DROP_MODE", "empty")
if os.environ.get("FAKE_TTS_SILENT") == "1":
    tone = fake.tone
    fake.tone = lambda seconds, *a, **k: bytes(len(tone(seconds, *a, **k)))
speech = fake.speech
calls = 0


async def faulty_speech(request):
    global calls
    calls += 1
    if not DROP_EVERY or calls % DROP_EVERY:
        return await speech(request)
    res = web.StreamResponse(headers={"Content-Type": "audio/pcm"})
    await res.prepare(request)
    if DROP_MODE == "abort":
        await res.write(fake.tone(0.1))
        request.transport.abort()
    return res


fake.speech = faulty_speech

if __name__ == "__main__":
    import logging

    logging.getLogger("aiohttp.server").setLevel(logging.CRITICAL)
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8900)
    web.run_app(fake.app(), host="127.0.0.1", port=parser.parse_args().port, access_log=None, print=None)
