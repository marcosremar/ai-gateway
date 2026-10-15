"""Engine choice on /v1/audio/speech (no GPU, no model): python3 docker/speech-stack/test_kokoro.py
A `model` with "kokoro" is spoken by Kokoro (fake engine here), anything else goes to the Qwen3-TTS proxy untouched.
Needs numpy, fastapi, httpx."""
import asyncio
import json
import os
import re
import struct
import subprocess
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.testclient import TestClient

src = Path(__file__).with_name("server.py").read_text()
calls: list[dict] = []
proxied: list[bytes] = []


class FakeKokoro:
    def create(self, text, voice, speed, lang):
        calls.append({"text": text, "voice": voice, "speed": speed, "lang": lang})
        return np.full(2400, 0.5, dtype=np.float32), 24000

    async def create_stream(self, text, voice, speed, lang):
        calls.append({"text": text, "voice": voice, "speed": speed, "lang": lang, "stream": True})
        for _ in range(3):
            yield np.full(1200, -0.5, dtype=np.float32), 24000


async def proxy(request: Request, url: str, stage: str):
    proxied.append(await request.body())
    return Response(b"qwen", media_type="audio/pcm")


app = FastAPI()
ns: dict = {"app": app, "Request": Request, "Response": Response, "JSONResponse": JSONResponse,
            "StreamingResponse": StreamingResponse, "asyncio": asyncio, "json": json, "np": np, "os": os, "re": re,
            "struct": struct, "subprocess": subprocess, "Path": Path, "SAMPLE_RATE": 24000, "TTS_URL": "http://tts", "proxy": proxy,
            "kokoro_state": {"status": "loading"}, "kokoro_engine": None}
exec(src[src.index("# ── Kokoro-82M"):src.index("# ── Engine logs")], ns)
exec(src[src.index('@app.post("/v1/audio/speech")'):src.index('@app.get("/refs/{name}")')], ns)
http = TestClient(app)


def speak(**body):
    return http.post("/v1/audio/speech", json={"input": "Olá, bom dia.", **body})


res = speak(model="kokoro")
assert res.status_code == 503 and res.json()["error"]["code"] == "kokoro_loading", res.text

ns["kokoro_engine"] = FakeKokoro()
ns["kokoro_state"].update(status="loaded", voices=["pf_dora", "pm_alex", "af_heart", "am_michael", "ff_siwis", "ef_dora",
                                                   "em_alex", "if_sara", "im_nicola", "bf_emma"])

res = speak(model="Qwen/Qwen3-TTS-12Hz-0.6B-Base", voice="br-f-01", response_format="pcm")
assert res.content == b"qwen" and json.loads(proxied[-1])["voice"] == "br-f-01" and not calls, (res.content, calls)

cases = [
    ({"voice": "br-f-01", "language": "pt"}, ("pf_dora", "pt-br")),
    ({"voice": "br-m-08", "language": "Portuguese"}, ("pm_alex", "pt-br")),
    ({"voice": "alloy", "language": "en-US"}, ("af_heart", "en-us")),
    ({"voice": "fr-m-01", "language": "fr"}, ("ff_siwis", "fr-fr")),
    ({"voice": "es-m-01", "language": "es"}, ("em_alex", "es")),
    ({"voice": "x", "language": "Italian"}, ("if_sara", "it")),
    ({"voice": "it-m-02", "language": "it"}, ("im_nicola", "it")),
    ({"voice": "bf_emma"}, ("bf_emma", "en-gb")),
    ({"voice": "ff_siwis", "language": "pt"}, ("ff_siwis", "pt-br")),
    ({}, ("pf_dora", "pt-br")),
]
for asked, (voice, lang) in cases:
    res = speak(model="hexgrad/Kokoro-82M", response_format="pcm", **asked)
    assert res.status_code == 200 and res.headers["content-type"] == "audio/pcm", (asked, res.status_code, res.text)
    assert (calls[-1]["voice"], calls[-1]["lang"]) == (voice, lang), (asked, calls[-1])

pcm = speak(model="kokoro", voice="pf_dora", response_format="pcm").content
assert len(pcm) == 4800 and np.frombuffer(pcm, "<i2")[0] == 16383, len(pcm)
wav = speak(model="kokoro", voice="pf_dora").content
assert wav[:4] == b"RIFF" and wav[8:16] == b"WAVEfmt " and struct.unpack("<I", wav[24:28])[0] == 24000, wav[:44]
assert struct.unpack("<I", wav[40:44])[0] == 4800 and wav[44:] == pcm

with http.stream("POST", "/v1/audio/speech", json={"model": "kokoro", "input": "Oi.", "voice": "pf_dora", "response_format": "pcm", "stream": True}) as res:
    streamed = b"".join(res.iter_bytes())
assert calls[-1].get("stream") and len(streamed) == 3 * 2400 and np.frombuffer(streamed, "<i2")[0] == -16383, len(streamed)

assert speak(model="kokoro", speed=9).status_code == 200 and calls[-1]["speed"] == 2.0
assert speak(model="kokoro", speed="fast").status_code == 400
assert speak(model="kokoro", response_format="ulaw").status_code == 400
assert speak(model="kokoro", input="  ").status_code == 400
print("ok: model *kokoro* → Kokoro with the language's stock voice (or the Kokoro voice asked), pcm/wav/stream as the Qwen path;"
      " any other model → the Qwen3-TTS proxy untouched; 503 while Kokoro loads")
