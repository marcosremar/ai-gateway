"""LLM inference with memory snapshots for fast cold starts."""

import snapgpu
from snapgpu.cls import enter

app = snapgpu.App("llm-service")

image = (
    snapgpu.Image.from_registry("nvidia/cuda:12.1.0-runtime-ubuntu22.04")
    .apt_install("python3-pip")
    .pip_install("torch", "transformers", "accelerate")
)

model_cache = snapgpu.Volume("llm-models")


@app.cls(
    image=image,
    gpu="A100",
    memory=65536,
    keep_warm=1,
    enable_memory_snapshot=True,
    volumes={"/models": model_cache},
)
class LLMModel:
    """LLM serving with snapshot-based fast restarts.

    First boot: loads model from HuggingFace (~30s) → snapshot created
    Subsequent boots: restore from snapshot (<2s) → model already in GPU memory
    """

    @enter(snap=True)
    def load_model(self):
        """Heavy init — runs before snapshot. Load model into GPU."""
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch

        model_name = "meta-llama/Llama-3.1-8B-Instruct"
        self.tokenizer = AutoTokenizer.from_pretrained(
            model_name, cache_dir="/models"
        )
        self.model = AutoModelForCausalLM.from_pretrained(
            model_name,
            cache_dir="/models",
            torch_dtype=torch.float16,
            device_map="auto",
        )
        print(f"[llm] Model loaded: {model_name}")

    @enter(snap=False)
    def reconnect(self):
        """Light init — runs after snapshot restore."""
        print("[llm] Post-restore: ready for inference")

    def generate(self, prompt: str, max_tokens: int = 256) -> dict:
        """Generate text from prompt."""
        inputs = self.tokenizer(prompt, return_tensors="pt").to(self.model.device)
        outputs = self.model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            do_sample=True,
            temperature=0.7,
        )
        text = self.tokenizer.decode(outputs[0], skip_special_tokens=True)
        return {"text": text, "model": "llama-3.1-8b", "tokens": len(outputs[0])}


@app.function(image=image, gpu="T4")
@snapgpu.fastapi_endpoint(method="POST")
def chat(data: dict) -> dict:
    """HTTP endpoint that calls the LLM class."""
    # In production, this would route to the class instance via the gateway
    return {"message": "Use LLMModel.generate() via the gateway", "input": data}
