"""TTS (Text-to-Speech) service with SnapGPU."""

import snapgpu
from snapgpu.cls import enter

app = snapgpu.App("tts-service")

image = (
    snapgpu.Image.from_registry("nvidia/cuda:12.1.0-runtime-ubuntu22.04")
    .apt_install("python3-pip", "ffmpeg", "libsndfile1")
    .pip_install("torch", "torchaudio", "transformers")
)


@app.cls(
    image=image,
    gpu="T4",
    keep_warm=2,
    enable_memory_snapshot=True,
)
class TTSModel:
    """TTS with snapshot support — first load ~15s, restore <2s."""

    @enter(snap=True)
    def load_model(self):
        from transformers import AutoProcessor, AutoModel
        import torch

        self.processor = AutoProcessor.from_pretrained("suno/bark-small")
        self.model = AutoModel.from_pretrained(
            "suno/bark-small",
            torch_dtype=torch.float16,
        ).to("cuda" if torch.cuda.is_available() else "cpu")
        print("[tts] Model loaded: bark-small")

    @enter(snap=False)
    def post_restore(self):
        print("[tts] Restored from snapshot — ready")

    def synthesize(self, text: str, voice: str = "v2/en_speaker_6") -> bytes:
        """Generate speech audio from text. Returns WAV bytes."""
        import torchaudio
        import io

        inputs = self.processor(text, voice_preset=voice, return_tensors="pt")
        inputs = {k: v.to(self.model.device) for k, v in inputs.items()}

        with __import__("torch").no_grad():
            output = self.model.generate(**inputs)

        audio = output.cpu().squeeze()
        buf = io.BytesIO()
        torchaudio.save(buf, audio.unsqueeze(0), 24000, format="wav")
        return buf.getvalue()


@app.function(image=image, gpu="T4")
@snapgpu.fastapi_endpoint(method="POST")
def speak(data: dict) -> dict:
    """HTTP endpoint for TTS."""
    import base64
    text = data.get("text", "Hello from SnapGPU!")
    # In production, would invoke TTSModel.synthesize via gateway
    return {"text": text, "message": "Use TTSModel.synthesize() via the gateway"}
