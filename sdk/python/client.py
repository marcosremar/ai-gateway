"""Async HTTP client for the BabelCast AI Gateway.

Includes circuit breaker, connection-level retry, and request ID tracing.
"""

import asyncio
import logging
import time
import uuid
from typing import Optional

import httpx

from gateway_sdk.types import (
    CircuitBreakerConfig,
    ComponentHealth,
    DeployOptions,
    GatewayMetrics,
    GpuStatus,
    HealthStatus,
    PipelineOptions,
    PipelineResult,
    PipelineTiming,
    RetryConfig,
    Timeouts,
    TranscribeResult,
    TranslateResult,
)

log = logging.getLogger(__name__)


# ── Circuit Breaker ──────────────────────────────────────────────────────────

class CircuitOpenError(Exception):
    """Raised when the circuit breaker is open and requests are blocked."""


class CircuitBreaker:
    """Circuit breaker: closed → open → half_open → closed."""

    def __init__(self, config: Optional[CircuitBreakerConfig] = None):
        self._config = config or CircuitBreakerConfig()
        self._state = "closed"
        self._failure_count = 0
        self._success_count = 0
        self._last_failure_time = 0.0

    @property
    def state(self) -> str:
        if self._state == "open":
            elapsed = time.monotonic() - self._last_failure_time
            if elapsed >= self._config.recovery_timeout:
                self._state = "half_open"
                self._success_count = 0
        return self._state

    def allow_request(self) -> None:
        if self.state == "open":
            raise CircuitOpenError("Circuit breaker is open — requests are blocked")

    def record_success(self) -> None:
        if self._state == "half_open":
            self._success_count += 1
            if self._success_count >= self._config.success_threshold:
                self._state = "closed"
                self._failure_count = 0
                self._success_count = 0
        else:
            self._failure_count = 0

    def record_failure(self) -> None:
        self._failure_count += 1
        self._last_failure_time = time.monotonic()
        if self._state == "half_open":
            self._state = "open"
            self._success_count = 0
        elif self._failure_count >= self._config.failure_threshold:
            self._state = "open"

    def reset(self) -> None:
        self._state = "closed"
        self._failure_count = 0
        self._success_count = 0
        self._last_failure_time = 0.0


# ── Errors ───────────────────────────────────────────────────────────────────

class GatewayError(Exception):
    """Raised when the gateway returns an HTTP error."""

    def __init__(self, message: str, status_code: int = 0, endpoint: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.endpoint = endpoint


# ── Helpers ──────────────────────────────────────────────────────────────────

_CONNECTION_ERRORS = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.RemoteProtocolError,
)


def _is_connection_error(err: Exception) -> bool:
    return isinstance(err, _CONNECTION_ERRORS)


# ── SDK Client ───────────────────────────────────────────────────────────────

class GatewaySDK:
    """Async client for the BabelCast AI Gateway (gateway-server.ts).

    Features:
        - Circuit breaker (stops sending after N consecutive failures)
        - Connection-level retry with backoff (NOT for HTTP errors)
        - X-Request-ID tracing on every request

    Usage:
        sdk = GatewaySDK(base_url="http://localhost:4000")
        text = await sdk.transcribe(audio_bytes, language="fr")
        await sdk.close()

    Or as an async context manager:
        async with GatewaySDK(base_url="http://localhost:4000") as sdk:
            text = await sdk.transcribe(audio_bytes, language="fr")
    """

    def __init__(
        self,
        base_url: str = "http://localhost:4000",
        api_key: str = "",
        timeouts: Optional[Timeouts] = None,
        retry: Optional[RetryConfig] = None,
        circuit_breaker: Optional[CircuitBreakerConfig] = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeouts = timeouts or Timeouts()
        self._retry = retry or RetryConfig()
        self._circuit_breaker = CircuitBreaker(circuit_breaker)
        self._http: Optional[httpx.AsyncClient] = None

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def circuit_breaker(self) -> CircuitBreaker:
        return self._circuit_breaker

    def _get_http(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeouts.pipeline,
            )
        return self._http

    def reset(self):
        """Recreate the HTTP client (for use in a new asyncio event loop)."""
        if self._http is not None:
            try:
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(self._http.aclose())
                except RuntimeError:
                    pass
            except Exception:
                pass
        self._http = None

    async def close(self):
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()

    # ── Internal request with retry + circuit breaker + request ID ────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        timeout: float = 30.0,
        content: Optional[bytes] = None,
        json: Optional[dict] = None,
        params: Optional[dict] = None,
        headers: Optional[dict] = None,
    ) -> httpx.Response:
        """Make an HTTP request with circuit breaker, retry, and request ID."""
        self._circuit_breaker.allow_request()

        request_id = str(uuid.uuid4())
        req_headers = {"X-Request-ID": request_id}
        if headers:
            req_headers.update(headers)

        http = self._get_http()
        last_error: Optional[Exception] = None
        max_attempts = 1 + self._retry.max_retries

        for attempt in range(max_attempts):
            if attempt > 0:
                delay = self._retry.backoff_factor * (2 ** (attempt - 1))
                log.debug("[req_id=%s] Retry %d/%d after %.1fs",
                          request_id, attempt, self._retry.max_retries, delay)
                await asyncio.sleep(delay)

            try:
                r = await http.request(
                    method, path,
                    content=content,
                    json=json,
                    params=params,
                    headers=req_headers,
                    timeout=timeout,
                )
                # HTTP errors are NOT retried
                if r.status_code >= 400:
                    self._circuit_breaker.record_failure()
                    raise GatewayError(
                        f"{method} {path}: {r.status_code} {r.text[:200]}",
                        status_code=r.status_code,
                        endpoint=path,
                    )
                self._circuit_breaker.record_success()
                return r

            except GatewayError:
                raise
            except CircuitOpenError:
                raise
            except Exception as e:
                last_error = e
                if not _is_connection_error(e) or attempt >= self._retry.max_retries:
                    self._circuit_breaker.record_failure()
                    raise
                log.debug("[req_id=%s] Connection error: %s", request_id, e)

        self._circuit_breaker.record_failure()
        raise last_error  # type: ignore[misc]

    # ── Health ────────────────────────────────────────────────────────────

    async def health(self) -> HealthStatus:
        """Check gateway health with component details."""
        try:
            r = await self._request(
                "GET", "/health", timeout=self._timeouts.health,
            )
            data = r.json()
            components = {}
            for name, comp in data.get("components", {}).items():
                components[name] = ComponentHealth(
                    status=comp.get("status", "ok"),
                    provider=comp.get("provider", ""),
                    reason=comp.get("reason", ""),
                    endpoint=comp.get("endpoint", ""),
                    healthy=comp.get("healthy"),
                    idle_sec=comp.get("idle_sec"),
                )
            return HealthStatus(
                status=data.get("status", "ok"),
                uptime_sec=data.get("uptime_sec", 0),
                components=components,
            )
        except Exception as e:
            log.debug("Gateway health check failed: %s", e)
            return HealthStatus(status="error", uptime_sec=0)

    # ── Metrics ──────────────────────────────────────────────────────────

    async def metrics(self) -> GatewayMetrics:
        """Fetch gateway metrics."""
        r = await self._request(
            "GET", "/metrics", timeout=self._timeouts.health,
        )
        data = r.json()
        return GatewayMetrics(
            requests_total=data.get("requestsTotal", 0),
            requests_by_stage=data.get("requestsByStage", {}),
            requests_by_provider=data.get("requestsByProvider", {}),
            errors_total=data.get("errorsTotal", 0),
            latency_p50_ms=data.get("latencyP50Ms", 0),
            latency_p95_ms=data.get("latencyP95Ms", 0),
            latency_p99_ms=data.get("latencyP99Ms", 0),
            gpu_status=data.get("gpuStatus", "idle"),
            uptime_sec=data.get("uptimeSec", 0),
        )

    # ── STT ──────────────────────────────────────────────────────────────

    async def transcribe(
        self, audio_bytes: bytes, language: str = "fr"
    ) -> TranscribeResult:
        r = await self._request(
            "POST", "/v1/transcribe",
            content=audio_bytes,
            params={"language": language},
            headers={"Content-Type": "audio/wav"},
            timeout=self._timeouts.stt,
        )
        data = r.json()
        return TranscribeResult(
            text=data.get("text", ""),
            used_gpu=data.get("used_gpu", False),
        )

    # ── Translation ──────────────────────────────────────────────────────

    async def translate(
        self, text: str, source_lang: str = "fr", target_lang: str = "en"
    ) -> TranslateResult:
        r = await self._request(
            "POST", "/v1/translate",
            json={"text": text, "source_lang": source_lang, "target_lang": target_lang},
            timeout=self._timeouts.translate,
        )
        data = r.json()
        return TranslateResult(
            translated_text=data.get("translated_text", ""),
            used_gpu=data.get("used_gpu", False),
        )

    # ── Pipeline ─────────────────────────────────────────────────────────

    async def pipeline(
        self,
        audio_bytes: bytes,
        options: Optional[PipelineOptions] = None,
    ) -> PipelineResult:
        opts = options or PipelineOptions()
        params = {"source": opts.source, "target": opts.target}
        if opts.speaker:
            params["speaker"] = opts.speaker
        r = await self._request(
            "POST", "/v1/speech",
            content=audio_bytes,
            params=params,
            headers={"Content-Type": "audio/wav"},
            timeout=self._timeouts.pipeline,
        )
        data = r.json()
        timing_data = data.get("timing", {})
        return PipelineResult(
            transcription=data.get("transcription", ""),
            response=data.get("response", ""),
            audio_base64=data.get("audio_base64", ""),
            content_type=data.get("content_type", ""),
            timing=PipelineTiming(
                total_ms=timing_data.get("total_ms", 0),
                stt_ms=timing_data.get("stt_ms", 0),
                llm_ms=timing_data.get("llm_ms", 0),
                tts_ms=timing_data.get("tts_ms", 0),
                used_gpu=timing_data.get("used_gpu", False),
            ),
        )

    # ── GPU management ───────────────────────────────────────────────────

    async def deploy_gpu(self, options: DeployOptions) -> dict:
        body = {"apiKey": options.api_key, "dockerImage": options.docker_image}
        if options.gpu_types:
            body["gpuTypes"] = options.gpu_types
        if options.vast_api_key:
            body["vastApiKey"] = options.vast_api_key
        if options.tensordock_api_key:
            body["tensordockApiKey"] = options.tensordock_api_key
        if options.tensordock_auth_id:
            body["tensordockAuthId"] = options.tensordock_auth_id
        if options.region:
            body["region"] = options.region
        if options.storage_gb:
            body["storageGb"] = options.storage_gb
        if options.hf_token:
            body["hfToken"] = options.hf_token
        if options.llm_model:
            body["llmModel"] = options.llm_model
        r = await self._request(
            "POST", "/v1/gpu/deploy",
            json=body,
            timeout=self._timeouts.deploy,
        )
        return r.json()

    async def gpu_status(self) -> GpuStatus:
        r = await self._request(
            "GET", "/v1/gpu/status",
            timeout=self._timeouts.health,
        )
        data = r.json()
        return GpuStatus(
            status=data.get("status", "idle"),
            pod_id=data.get("podId", ""),
            endpoint=data.get("endpoint", ""),
            gpu_type=data.get("gpuType", ""),
            message=data.get("message", ""),
            step=data.get("step", ""),
            step_detail=data.get("stepDetail", ""),
            elapsed_sec=data.get("elapsedSec", 0),
            gpu_healthy=data.get("gpuHealthy", False),
            active_tier=data.get("activeTier", "cloud"),
            idle_sec=data.get("idleSec", 0),
            idle_timeout_sec=data.get("idleTimeoutSec", 900),
            started_at=data.get("startedAt", 0),
            retry_count=data.get("retryCount", 0),
        )

    async def terminate_gpu(self, api_key: str) -> dict:
        r = await self._request(
            "POST", "/v1/gpu/terminate",
            json={"apiKey": api_key},
            timeout=self._timeouts.deploy,
        )
        return r.json()
