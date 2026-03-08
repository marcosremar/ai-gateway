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


@dataclass
class DeployOptions:
    api_key: str
    docker_image: str = ""
    gpu_types: Optional[list[str]] = None


@dataclass
class DeployResponse:
    status: str
    message: str


# ── Errors ───────────────────────────────────────────────────────────────────


class GatewayError(Exception):
    """Raised when the gateway returns a non-OK response."""

    def __init__(self, message: str, status_code: int = 0, endpoint: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.endpoint = endpoint
