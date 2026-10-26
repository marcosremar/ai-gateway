"""gateway_sdk — Python HTTP SDK for the BabelCast AI Gateway REST API.

Usage:
    from gateway_sdk import GatewaySDK

    gw = GatewaySDK(base_url="http://localhost:4000")
    result = await gw.transcribe(audio_bytes, language="fr")
    print(result.text)

Mirror SDK: ai-gateway/src/sdk/ (TypeScript)
"""

from gateway_sdk.client import GatewaySDK
from gateway_sdk.types import RaceConfig, RetryMode
from gateway_sdk.types import (
    ApiKeyEntry,
    ApiKeysResponse,
    CatalogModel,
    CatalogProvider,
    CatalogResponse,
    CatalogVoice,
    ChatCompletionResponse,
    GatewayConfig,
    GatewayError,
    GpuLogsResponse,
    HealthResponse,
    MetricsResponse,
    PipelineChainEntry,
    ProviderConfigResponse,
    App,
    Profile,
    ProviderProfile,
    RaceConfig,
    RequestLogEntry,
    RequestLogResponse,
    RequestLogStats,
    RetryMode,
    TranscribeResponse,
    EnsembleTranscribeResponse,
    TranslateResponse,
    PipelineResponse,
    PipelineOptions,
    GpuStatus,
    DeployOptions,
    DeployResponse,
)

# Microphone advice (VAD segmentation + what the room sounds like): `AudioSegmenter.mic_report()`.
from gateway_sdk.audio import AudioSegment, AudioSegmenter, AudioSegmenterConfig, Floor, MicCheck, MicIssue, MicReport

__all__ = [
    "GatewaySDK",
    "ApiKeyEntry",
    "ApiKeysResponse",
    "CatalogModel",
    "CatalogProvider",
    "CatalogResponse",
    "CatalogVoice",
    "ChatCompletionResponse",
    "GatewayConfig",
    "GatewayError",
    "GpuLogsResponse",
    "HealthResponse",
    "MetricsResponse",
    "PipelineChainEntry",
    "ProviderConfigResponse",
    "App",
    "Profile",
    "ProviderProfile",
    "RaceConfig",
    "RequestLogEntry",
    "RequestLogResponse",
    "RequestLogStats",
    "RetryMode",
    "TranscribeResponse",
    "EnsembleTranscribeResponse",
    "TranslateResponse",
    "PipelineResponse",
    "PipelineOptions",
    "GpuStatus",
    "DeployOptions",
    "DeployResponse",
    "AudioSegment",
    "AudioSegmenter",
    "AudioSegmenterConfig",
    "Floor",
    "MicCheck",
    "MicIssue",
    "MicReport",
]
