"""BabelCast Gateway SDK — Python client for the ai-gateway server.

Provides typed async methods for all gateway endpoints:
  - STT (transcribe)
  - Translation
  - Full pipeline (STT + LLM + TTS)
  - GPU deployment management
  - Health checks
"""

from gateway_sdk.client import CircuitBreaker, CircuitOpenError, GatewayError, GatewaySDK
from gateway_sdk.types import (
    CircuitBreakerConfig,
    ComponentHealth,
    GatewayMetrics,
    HealthStatus,
    RetryConfig,
)

__all__ = [
    "GatewaySDK",
    "GatewayError",
    "CircuitBreaker",
    "CircuitOpenError",
    "CircuitBreakerConfig",
    "RetryConfig",
    "HealthStatus",
    "ComponentHealth",
    "GatewayMetrics",
]
