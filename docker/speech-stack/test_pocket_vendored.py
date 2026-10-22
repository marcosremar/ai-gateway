"""Pocket sidecar of the GPU image (pocket_server.py) with a fake model, and the vendored copies of the CPU voice
server's pocket.py / normalize.py kept identical: python3 docker/speech-stack/test_pocket_vendored.py
Needs numpy, fastapi, httpx, num2words (no torch, no pocket-tts)."""
import json
import threading
import time
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

here = Path(__file__).parent
upstream = here.parent / "kokoro-stream"
for name in ("pocket.py", "normalize.py"):
    if upstream.exists():
        mine = (here / name).read_bytes().replace(b"\r\n", b"\n")
        theirs = (upstream / name).read_bytes().replace(b"\r\n", b"\n")
        assert mine == theirs, f"docker/speech-stack/{name} must be a copy of docker/kokoro-stream/{name}: cp it again"

import pocket  # noqa: E402
import pocket_server  # noqa: E402


class FakeModel:
    sample_rate = 24_000

    def __init__(self, lang):
        self.lang, self.spoken = lang, []

    def get_state_for_audio_prompt(self, voice):
        return {"voice": voice}

    def generate_audio_stream(self, state, text, stop=None):
        self.spoken.append((state["voice"], text))
        yield np.full(2400, 0.5, dtype=np.float32)


models: dict = {}
pocket_server.pocket = pocket.Pocket(enabled=True, loader=lambda lang: models.setdefault(lang, FakeModel(lang)), wait_s=0.05)
http = TestClient(pocket_server.app)


def speak(**body):
    return http.post("/v1/audio/speech", json={"input": "Olá, são 8h30.", **body})


assert http.get("/health").json()["pocket"]["languages"]["pt"] == "not_loaded"
res = speak(voice="Ryan", language="Portuguese")
assert res.status_code == 503 and res.json()["error"]["code"] == "loading", res.text
for _ in range(200):
    if pocket_server.pocket.status.get("pt") == "loaded":
        break
    time.sleep(0.01)
res = speak(voice="Ryan", language="Portuguese", response_format="wav")
assert res.status_code == 200 and res.content[:4] == b"RIFF" and len(res.content) == 44 + 4800, (res.status_code, res.text[:200])
assert models["pt"].spoken[-1] == ("rafael", "Olá, são oito horas e trinta."), models["pt"].spoken
assert speak(voice="Vivian", language="pt").status_code == 200 and models["pt"].spoken[-1][0] == "estelle"
assert speak(voice="br-m-08", language="pt").status_code == 200 and models["pt"].spoken[-1][0] == "rafael"
assert speak(voice="lola", language="pt").status_code == 200 and models["pt"].spoken[-1][0] == "lola", "a Pocket voice is kept"
for body, code in [({"voice": "x", "language": "ja"}, "invalid_language"), ({"voice": "x", "language": "pt", "response_format": "mp3"}, "invalid_response_format"),
                   ({"voice": "x", "language": "pt", "speed": 9}, "invalid_speed"), ({"input": " ", "voice": "x", "language": "pt"}, "invalid_input")]:
    res = speak(**body)
    assert res.status_code == 400 and res.json()["error"]["code"] == code, (body, res.text)
assert pocket_server.pocket.acquire("pt")
assert speak(voice="x", language="pt").json()["error"]["code"] == "busy"
pocket_server.pocket.release("pt")
assert json.loads(http.get("/health").text)["pocket"]["languages"]["pt"] == "loaded"
assert threading.active_count() >= 1
print("pocket sidecar: ok — vendored files identical, loading → 503 then speech, voices mapped to the language's own, refusals")
