import hmac
import io
import os

import modal

MODEL_FILES = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
LANG_OF_VOICE = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("kokoro-onnx==0.4.9", "soundfile==0.12.1", "fastapi[standard]==0.115.6")
    .run_commands(
        "mkdir -p /models",
        f"python -c \"import urllib.request as u; u.urlretrieve('{MODEL_FILES}/kokoro-v1.0.onnx', '/models/kokoro-v1.0.onnx'); "
        f"u.urlretrieve('{MODEL_FILES}/voices-v1.0.bin', '/models/voices-v1.0.bin')\"",
    )
)
app = modal.App("babelcast-kokoro", image=image)


def authorized(key: str | None, secret: str | None) -> bool:
    return hmac.compare_digest(key or "", os.environ["KOKORO_KEY"]) and hmac.compare_digest(secret or "", os.environ["KOKORO_SECRET"])


@app.cls(cpu=2.0, memory=2048, scaledown_window=300, secrets=[modal.Secret.from_name("babelcast-kokoro-auth")])
@modal.concurrent(max_inputs=4)
class KokoroTTS:
    @modal.enter()
    def load(self):
        from kokoro_onnx import Kokoro

        self.kokoro = Kokoro("/models/kokoro-v1.0.onnx", "/models/voices-v1.0.bin")

    @modal.asgi_app()
    def serve(self):
        import soundfile
        from fastapi import FastAPI, Header, HTTPException
        from fastapi.responses import Response

        api = FastAPI()

        @api.get("/health")
        def health():
            return {"status": "ok"}

        @api.post("/v1/audio/speech")
        def speech(body: dict, modal_key: str | None = Header(None), modal_secret: str | None = Header(None)):
            if not authorized(modal_key, modal_secret):
                raise HTTPException(status_code=401, detail="unauthorized")
            text = str(body.get("input") or "").strip()
            if not text:
                raise HTTPException(status_code=400, detail="input is empty")
            voice = str(body.get("voice") or "af_heart")
            samples, rate = self.kokoro.create(text, voice=voice, speed=float(body.get("speed") or 1.0), lang=LANG_OF_VOICE.get(voice[:1], "en-us"))
            wav = io.BytesIO()
            soundfile.write(wav, samples, rate, format="WAV", subtype="PCM_16")
            return Response(wav.getvalue(), media_type="audio/wav")

        return api
