"""Response types for the BabelCast AI Gateway SDK.

Keep in sync with: ai-gateway/src/sdk/types.ts
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ── Configuration ────────────────────────────────────────────────────────────


class RetryMode(str, Enum):
    """SDK transcription/inference retry strategy."""
    REALTIME = "realtime"  # parallel race waves — low latency, higher cost
    BATCH = "batch"        # sequential retries — lower cost, higher latency


@dataclass
class RaceConfig:
    """Configuration for parallel wave racing in REALTIME mode."""
    wave_size: int = 2            # parallel slots per wave (providers per wave)
    wave_timeout_s: float = 3.0   # seconds before a wave is considered failed
    max_waves: int = 3            # maximum number of waves before giving up
    mode: RetryMode = RetryMode.REALTIME
    adaptive_window: int = 10     # rolling window for adaptive wave sizing


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
    detected_language: str = ""
    avg_logprob: float = 0.0


@dataclass
class EnsembleTranscribeResponse:
    consensus: str                    # best transcription (highest avg similarity to others)
    providers: dict[str, str]         # {provider_name: text} for each provider that succeeded
    used_providers: int               # number of providers that returned results
    latency_ms: int                   # total wall-clock time
    scores: dict[str, float] = field(default_factory=dict)   # {provider_name: similarity_score}
    outliers: list[str] = field(default_factory=list)        # providers flagged as outliers
    similarity_method: str = "jaccard"  # 'jaccard' | 'embedding'
    embedding_provider: str = ""        # name of embedding provider used (if method='embedding')
    corrected: str = ""                 # LLM-corrected text (only set when llm_correct=True)
    correction_applied: bool = False    # True if LLM changed the consensus text


@dataclass
class TranslateResponse:
    translated_text: str
    used_gpu: bool


@dataclass
class ChatCompletionResponse:
    content: str
    model: str
    usage: dict | None = None


@dataclass
class ApiKeyEntry:
    id: str
    name: str
    env_var: str
    category: str  # "cloud" | "gpu"
    configured: bool
    masked: str = ""


@dataclass
class ApiKeysResponse:
    keys: list[ApiKeyEntry]
    saved: bool = False


@dataclass
class PipelineChainEntry:
    provider: str
    model: str
    voice: str = ""


@dataclass
class ProviderProfile:
    id: str
    name: str
    stt: list[PipelineChainEntry]
    llm: list[PipelineChainEntry]
    tts: list[PipelineChainEntry]


@dataclass
class ProviderConfigResponse:
    profiles: list[ProviderProfile]
    active_profile_id: str | None
    pipeline_stt: list[PipelineChainEntry]
    pipeline_llm: list[PipelineChainEntry]
    pipeline_tts: list[PipelineChainEntry]
    updated_at: int = 0


@dataclass
class CatalogModel:
    id: str
    name: str
    description: str
    provider_id: str
    is_default: bool = False


@dataclass
class CatalogVoice:
    id: str
    name: str
    provider_id: str
    description: str = ""


@dataclass
class CatalogProvider:
    id: str
    name: str
    description: str
    available: bool
    capabilities: list[str]


@dataclass
class CatalogResponse:
    providers: list[CatalogProvider]
    capabilities: dict  # raw dict with stt/llm/tts keys containing models/voices
    gpu: dict  # raw dict with available, endpoint, warmth info
    defaults: dict  # raw dict with stt/llm/tts default provider+model
    languages: list[dict]  # list of {code, name}


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
    reference_audio: str = ""  # base64 WAV for voice cloning
    ref_text: str = ""         # transcription of reference audio
    ref_id: str = ""           # cached voice reference ID (from /v1/voice-reference)
    stt_prompt: str = ""       # Whisper initial_prompt (recent transcript context)
    style: str = "default"     # translation style hint


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
    cost_per_hr: float = 0.0
    docker_image: str = ""
    region: str = ""
    ip_flag: str = ""
    ip_city: str = ""
    ip_country: str = ""
    boot_on_startup: bool = False


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
    race_count: int = 0  # parallel deploy race (0=disabled)
    provider: str = ""  # force provider: "runpod" | "vast" | "tensordock" | "" (auto)


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


# ── Request log ──────────────────────────────────────────────────────────────


@dataclass
class RequestLogEntry:
    id: int
    timestamp: int  # epoch ms
    stage: str  # 'stt' | 'llm' | 'tts' | 'translate'
    provider: str
    model: str
    latency_ms: int
    success: bool
    error: str = ""
    input_size: int = 0
    output_preview: str = ""


@dataclass
class RequestLogStats:
    total_requests: int
    gpu_requests: int
    cloud_requests: int
    total_latency_ms: int
    avg_latency_ms: int
    gpu_percent: int
    errors: int
    by_stage: dict = field(default_factory=dict)


@dataclass
class RequestLogResponse:
    entries: list[RequestLogEntry]
    stats: RequestLogStats


# ── Metrics ──────────────────────────────────────────────────────────────────


@dataclass
class MetricsResponse:
    requests_total: int
    requests_by_stage: dict
    requests_by_provider: dict
    errors_total: int
    db_log_failures: int
    latency_p50_ms: int
    latency_p95_ms: int
    latency_p99_ms: int
    gpu_status: str
    uptime_sec: int


# ── Health detail ────────────────────────────────────────────────────────────


@dataclass
class HealthResponse:
    status: str  # 'ok' | 'degraded'
    uptime_sec: int
    gpu: str  # deploy state status
    providers: dict
    components: dict
    reason: str = ""


# ── GPU logs ─────────────────────────────────────────────────────────────────


@dataclass
class GpuLogsResponse:
    logs: str
    ssh_host: str
    ssh_port: int
    endpoint: str
    pod_id: str
    provider: str
    status: str


# ── Errors ───────────────────────────────────────────────────────────────────


class GatewayError(Exception):
    """Raised when the gateway returns a non-OK response."""

    def __init__(self, message: str, status_code: int = 0, endpoint: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.endpoint = endpoint
