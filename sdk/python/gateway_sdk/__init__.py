"""gateway_sdk — Python HTTP SDK for the BabelCast AI Gateway REST API.

Usage:
    from gateway_sdk import GatewaySDK

    gw = GatewaySDK(base_url="http://localhost:4000")
    result = await gw.transcribe(audio_bytes, language="fr")
    print(result.text)

Mirror SDK: ai-gateway/src/sdk/ (TypeScript)
"""

from gateway_sdk.client import GatewaySDK
from gateway_sdk.types import (
    GatewayConfig,
    GatewayError,
    GpuLogsResponse,
    HealthResponse,
    MetricsResponse,
    RequestLogEntry,
    RequestLogResponse,
    RequestLogStats,
    TranscribeResponse,
    EnsembleTranscribeResponse,
    TranslateResponse,
    PipelineResponse,
    PipelineOptions,
    GpuStatus,
    DeployOptions,
    DeployResponse,
)

__all__ = [
    "GatewaySDK",
    "GatewayConfig",
    "GatewayError",
    "GpuLogsResponse",
    "HealthResponse",
    "MetricsResponse",
    "RequestLogEntry",
    "RequestLogResponse",
    "RequestLogStats",
    "TranscribeResponse",
    "EnsembleTranscribeResponse",
    "TranslateResponse",
    "PipelineResponse",
    "PipelineOptions",
    "GpuStatus",
    "DeployOptions",
    "DeployResponse",
]
