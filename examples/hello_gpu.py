"""Simple SnapGPU example — GPU function with fast cold starts."""

import snapgpu

app = snapgpu.App("hello-gpu")

image = (
    snapgpu.Image.debian_slim("3.11")
    .pip_install("torch", "numpy")
)

@app.function(image=image, gpu="T4", timeout=60)
def hello(name: str = "World") -> dict:
    """Simple GPU function that checks CUDA availability."""
    import torch
    return {
        "message": f"Hello {name} from SnapGPU!",
        "cuda_available": torch.cuda.is_available(),
        "device_count": torch.cuda.device_count() if torch.cuda.is_available() else 0,
    }


@app.function(image=image, gpu="T4")
def matrix_multiply(size: int = 1000) -> dict:
    """GPU matrix multiplication benchmark."""
    import torch
    import time

    device = "cuda" if torch.cuda.is_available() else "cpu"
    a = torch.randn(size, size, device=device)
    b = torch.randn(size, size, device=device)

    if device == "cuda":
        torch.cuda.synchronize()

    start = time.time()
    c = torch.matmul(a, b)
    if device == "cuda":
        torch.cuda.synchronize()
    elapsed = time.time() - start

    return {
        "size": size,
        "device": device,
        "elapsed_ms": round(elapsed * 1000, 2),
        "gflops": round(2 * size**3 / elapsed / 1e9, 2),
    }
