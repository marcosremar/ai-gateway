"""Response types for the BabelCast AI Gateway SDK.

Keep in sync with: ai-gateway/src/sdk/types.ts
"""

from dataclasses import dataclass, field
from typing import Optional


# ── Configuration ────────────────────────────────────────────────────────────


@dataclass
class Timeouts:
    """Per-endpoint timeout overrides (seconds)."""
    stt: float = 15.0
    translate: float = 15.0
    pipeline: float = 30.0
    health: float = 8.0
    deploy: float = 30.0


@dataclass
class GatewayConfig:
    """Configuration for GatewaySDK."""
    base_url: str
    api_key: str = ""
    timeouts: Timeouts = field(default_factory=Timeouts)


# ── Inference responses ──────────────────────────────────────────────────────


@dataclass
class TranscribeResponse:
    text: str
    used_gpu: bool


@dataclass
class TranslateResponse:
    translated_text: str
    used_gpu: bool


@dataclass
class PipelineTiming:
    total_ms: int
    used_gpu: bool
    stt_ms: int = 0
    llm_ms: int = 0
    tts_ms: int = 0


@dataclass
class PipelineResponse:
    transcription: str
    response: str
    audio_base64: str
    content_type: str
    timing: PipelineTiming


@dataclass
class PipelineOptions:
    source: str = "fr"
    target: str = "en"
    speaker: str = ""


# ── GPU management responses ────────────────────────────────────────────────


@dataclass
class GpuStatus:
    status: str  # 'idle' | 'creating' | 'booting' | 'installing' | 'ready' | 'error'
    pod_id: str
    endpoint: str
    gpu_type: str
    message: str
    step: str
    step_detail: str
    gpu_healthy: bool
    active_tier: str  # 'gpu' | 'cloud'
    idle_sec: int
    idle_timeout_sec: int
    elapsed_sec: int
    started_at: int
    retry_count: int
    provider: str = ""   # 'runpod' | 'vast' | ''
    alert: str = ""      # e.g. "RunPod blocked, using Vast.ai fallback"


@dataclass
class DeployOptions:
    api_key: str
    docker_image: str = ""
    gpu_types: Optional[list[str]] = None
    vast_api_key: str = ""
    region: str = ""
    storage_gb: int = 0
    hf_token: str = ""
    tensordock_api_key: str = ""
    tensordock_auth_id: str = ""
    llm_model: str = ""  # "translategemma" or "mistral"
    interruptible: Optional[bool] = None  # True=spot (cheaper), False/None=on-demand (default)


@dataclass
class DeployResponse:
    status: str
    message: str


# ── GPU Offer Discovery ────────────────────────────────────────────────────


@dataclass
class GpuOffer:
    provider: str
    gpu_type: str
    gpu_name: str
    available: int
    price_per_hr: float
    region: str
    vram: float
    offer_id: str = ""
    spot_price_per_hr: float = 0.0  # Spot price, 0 if unavailable


@dataclass
class GpuOffersResponse:
    offers: list[GpuOffer]
    providers: list[dict]


# ── Errors ───────────────────────────────────────────────────────────────────


class GatewayError(Exception):
    """Raised when the gateway returns a non-OK response."""

    def __init__(self, message: str, status_code: int = 0, endpoint: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.endpoint = endpoint
