"""Type definitions for the BabelCast Gateway SDK."""

from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass
class Timeouts:
    """HTTP timeout configuration (seconds)."""
    stt: float = 15.0
    translate: float = 15.0
    pipeline: float = 30.0
    health: float = 8.0
    deploy: float = 30.0


@dataclass
class RetryConfig:
    """Connection-level retry configuration."""
    max_retries: int = 2
    backoff_factor: float = 0.5  # delays: 0.5s, 1.0s


@dataclass
class CircuitBreakerConfig:
    """Circuit breaker configuration."""
    failure_threshold: int = 5
    recovery_timeout: float = 30.0  # seconds
    success_threshold: int = 2


@dataclass
class DeployOptions:
    """Options for GPU pod deployment."""
    api_key: str = ""
    docker_image: str = "marcosremar/babelcast:latest"
    gpu_types: list = field(default_factory=list)
    vast_api_key: str = ""
    tensordock_api_key: str = ""
    tensordock_auth_id: str = ""
    region: str = ""
    storage_gb: int = 0
    hf_token: str = ""


@dataclass
class PipelineOptions:
    """Options for the full STT -> LLM -> TTS pipeline."""
    source: str = "fr"
    target: str = "en"
    speaker: str = "Ryan"


@dataclass
class TranscribeResult:
    """Result from a transcription request."""
    text: str = ""
    used_gpu: bool = False


@dataclass
class TranslateResult:
    """Result from a translation request."""
    translated_text: str = ""
    used_gpu: bool = False


@dataclass
class PipelineTiming:
    """Timing info from a pipeline request."""
    total_ms: int = 0
    stt_ms: int = 0
    llm_ms: int = 0
    tts_ms: int = 0
    used_gpu: bool = False


@dataclass
class PipelineResult:
    """Result from a full pipeline request."""
    transcription: str = ""
    response: str = ""
    audio_base64: str = ""
    content_type: str = ""
    timing: PipelineTiming = field(default_factory=PipelineTiming)


@dataclass
class GpuStatus:
    """GPU deployment status from the gateway."""
    status: str = "idle"  # idle | creating | booting | installing | ready | error
    pod_id: str = ""
    endpoint: str = ""
    gpu_type: str = ""
    message: str = ""
    step: str = ""
    step_detail: str = ""
    elapsed_sec: int = 0
    gpu_healthy: bool = False
    active_tier: str = "cloud"  # cloud | gpu
    idle_sec: int = 0
    idle_timeout_sec: int = 900
    started_at: int = 0
    retry_count: int = 0


# ── Health types ─────────────────────────────────────────────────────────────

@dataclass
class ComponentHealth:
    """Health status of a single gateway component."""
    status: str = "ok"  # ok | degraded | unavailable
    provider: str = ""
    reason: str = ""
    endpoint: str = ""
    healthy: Optional[bool] = None
    idle_sec: Optional[int] = None


@dataclass
class HealthStatus:
    """Detailed health status from the gateway."""
    status: str = "ok"  # ok | degraded | error
    uptime_sec: float = 0
    components: Dict[str, ComponentHealth] = field(default_factory=dict)

    @property
    def is_healthy(self) -> bool:
        return self.status in ("ok", "degraded")


# ── Metrics types ────────────────────────────────────────────────────────────

@dataclass
class GatewayMetrics:
    """In-memory metrics from the gateway."""
    requests_total: int = 0
    requests_by_stage: Dict[str, int] = field(default_factory=dict)
    requests_by_provider: Dict[str, int] = field(default_factory=dict)
    errors_total: int = 0
    latency_p50_ms: int = 0
    latency_p95_ms: int = 0
    latency_p99_ms: int = 0
    gpu_status: str = "idle"
    uptime_sec: float = 0
