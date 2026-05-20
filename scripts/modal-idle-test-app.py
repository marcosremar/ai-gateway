"""Temporary Modal app used to verify ai-gateway Modal idle shutdown.

Deploy:
    python3 -m modal deploy scripts/modal-idle-test-app.py
"""

import modal

app = modal.App("aigw-idle-test")

image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi>=0.115.0",
)


@app.function(
    image=image,
    min_containers=1,
    scaledown_window=300,
)
@modal.asgi_app()
def web():
    from fastapi import FastAPI

    api = FastAPI(title="ai-gateway Modal idle test")

    @api.get("/health")
    def health():
        return {"ok": True, "service": "aigw-idle-test"}

    return api
