"""GatewaySDK — Typed HTTP client for the BabelCast AI Gateway REST API.

Usage:
    from gateway_sdk import GatewaySDK

    async with GatewaySDK(base_url="http://localhost:4000") as gw:
        result = await gw.transcribe(audio_bytes, language="fr")
        print(result.text)

        translation = await gw.translate(result.text, "fr", "en")
        print(translation.translated_text)

Mirror SDK: ai-gateway/src/sdk/client.ts (TypeScript)
"""

import asyncio
import logging
import threading
from typing import Optional

import httpx

from gateway_sdk.types import (
    GatewayConfig,
    GatewayError,
    GpuOffer,
    GpuOffersResponse,
    Timeouts,
    TranscribeResponse,
    TranslateResponse,
    PipelineResponse,
    PipelineTiming,
    PipelineOptions,
    GpuStatus,
    DeployOptions,
    DeployResponse,
)

log = logging.getLogger(__name__)


class GatewaySDK:
    """Async HTTP client for the BabelCast AI Gateway.

    All inference methods are GPU-aware — the gateway routes to GPU pod
    when available, falls back to cloud (Groq) automatically.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:4000",
        api_key: str = "",
        timeouts: Optional[Timeouts] = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeouts = timeouts or Timeouts()
        self._http: Optional[httpx.AsyncClient] = None
        self._http_lock = threading.Lock()

    @property
    def base_url(self) -> str:
        return self._base_url

    def _get_http(self) -> httpx.AsyncClient:
        """Lazy-create the HTTP client (thread-safe)."""
        with self._http_lock:
            if self._http is None or self._http.is_closed:
                headers = {}
                if self._api_key:
                    headers["Authorization"] = f"Bearer {self._api_key}"
                self._http = httpx.AsyncClient(
                    base_url=self._base_url,
                    headers=headers,
                    timeout=self._timeouts.health,
                )
            return self._http

    def reset(self) -> None:
        """Recreate the HTTP client (call when switching event loops).

        Properly closes the old client if possible, otherwise marks it
        for GC. Thread-safe via lock.
        """
        with self._http_lock:
            old = self._http
            self._http = None

        if old and not old.is_closed:
            try:
                loop = asyncio.get_event_loop()
                if not loop.is_running():
                    loop.run_until_complete(old.aclose())
                else:
                    # Schedule close on the running loop (non-blocking)
                    loop.create_task(old.aclose())
            except Exception:
                pass  # loop already closed or no loop — client will be GC'd

    # ── Inference ─────────────────────────────────────────────────────────

    async def transcribe(self, audio: bytes, language: str = "fr") -> TranscribeResponse:
        """Transcribe audio to text (GPU-aware routing)."""
        http = self._get_http()
        r = await http.post(
            "/v1/transcribe",
            content=audio,
            params={"language": language},
            headers={"Content-Type": "audio/wav"},
            timeout=self._timeouts.stt,
        )
        self._check_response(r, "/v1/transcribe")
        data = self._parse_json(r, "/v1/transcribe")
        return TranscribeResponse(
            text=data.get("text", ""),
            used_gpu=data.get("used_gpu", False),
        )

    async def translate(
        self, text: str, source_lang: str, target_lang: str
    ) -> TranslateResponse:
        """Translate text (GPU-aware routing)."""
        if not text.strip():
            return TranslateResponse(translated_text="", used_gpu=False)

        http = self._get_http()
        r = await http.post(
            "/v1/translate",
            json={"text": text, "source_lang": source_lang, "target_lang": target_lang},
            timeout=self._timeouts.translate,
        )
        self._check_response(r, "/v1/translate")
        data = self._parse_json(r, "/v1/translate")
        return TranslateResponse(
            translated_text=data.get("translated_text", ""),
            used_gpu=data.get("used_gpu", False),
        )

    async def pipeline(
        self,
        audio: bytes,
        options: Optional[PipelineOptions] = None,
    ) -> PipelineResponse:
        """Full pipeline: audio -> STT -> LLM -> TTS (GPU-aware routing)."""
        opts = options or PipelineOptions()
        params = {"source": opts.source, "target": opts.target}
        if opts.speaker:
            params["speaker"] = opts.speaker

        http = self._get_http()
        r = await http.post(
            "/v1/speech",
            content=audio,
            params=params,
            headers={"Content-Type": "audio/wav"},
            timeout=self._timeouts.pipeline,
        )
        self._check_response(r, "/v1/speech")
        data = self._parse_json(r, "/v1/speech")
        timing = data.get("timing", {})
        return PipelineResponse(
            transcription=data.get("transcription", ""),
            response=data.get("response", ""),
            audio_base64=data.get("audio_base64", ""),
            content_type=data.get("content_type", ""),
            timing=PipelineTiming(
                total_ms=timing.get("total_ms", 0),
                used_gpu=timing.get("used_gpu", False),
                stt_ms=timing.get("stt_ms", 0),
                llm_ms=timing.get("llm_ms", 0),
                tts_ms=timing.get("tts_ms", 0),
            ),
        )

    # ── GPU management ────────────────────────────────────────────────────

    async def deploy_gpu(self, options: DeployOptions) -> DeployResponse:
        """Deploy a GPU pod (non-blocking — returns immediately, poll gpu_status())."""
        http = self._get_http()
        body: dict = {"apiKey": options.api_key}
        if options.docker_image:
            body["dockerImage"] = options.docker_image
        if options.gpu_types:
            body["gpuTypes"] = options.gpu_types
        if options.vast_api_key:
            body["vastApiKey"] = options.vast_api_key
        if options.region:
            body["region"] = options.region
        if options.storage_gb:
            body["storageGb"] = options.storage_gb
        if options.hf_token:
            body["hfToken"] = options.hf_token
        if options.tensordock_api_key:
            body["tensordockApiKey"] = options.tensordock_api_key
        if options.tensordock_auth_id:
            body["tensordockAuthId"] = options.tensordock_auth_id
        if options.llm_model:
            body["llmModel"] = options.llm_model

        r = await http.post(
            "/v1/gpu/deploy",
            json=body,
            timeout=self._timeouts.deploy,
        )
        # 409 = deploy already in progress (not an error)
        if r.status_code not in (200, 201, 202, 409):
            self._check_response(r, "/v1/gpu/deploy")
        data = self._parse_json(r, "/v1/gpu/deploy")
        return DeployResponse(
            status=data.get("status", ""),
            message=data.get("message", ""),
        )

    async def gpu_status(self) -> GpuStatus:
        """Get current GPU deployment status, health, and active tier."""
        http = self._get_http()
        r = await http.get("/v1/gpu/status", timeout=self._timeouts.health)
        self._check_response(r, "/v1/gpu/status")
        d = self._parse_json(r, "/v1/gpu/status")
        return GpuStatus(
            status=d.get("status", "idle"),
            pod_id=d.get("podId", ""),
            endpoint=d.get("endpoint", ""),
            gpu_type=d.get("gpuType", ""),
            message=d.get("message", ""),
            step=d.get("step", ""),
            step_detail=d.get("stepDetail", ""),
            gpu_healthy=d.get("gpuHealthy", False),
            active_tier=d.get("activeTier", "cloud"),
            idle_sec=d.get("idleSec", 0),
            idle_timeout_sec=d.get("idleTimeoutSec", 0),
            elapsed_sec=d.get("elapsedSec", 0),
            started_at=d.get("startedAt", 0),
            retry_count=d.get("retryCount", 0),
            provider=d.get("provider", ""),
            alert=d.get("alert", ""),
        )

    async def terminate_gpu(self, api_key: str) -> None:
        """Terminate the GPU pod."""
        http = self._get_http()
        r = await http.post(
            "/v1/gpu/terminate",
            json={"apiKey": api_key},
            timeout=self._timeouts.deploy,
        )
        self._check_response(r, "/v1/gpu/terminate")

    async def gpu_offers(
        self,
        gpu_types: Optional[list[str]] = None,
        region: Optional[str] = None,
        provider: Optional[str] = None,
        limit: int = 100,
    ) -> GpuOffersResponse:
        """List available GPU offers across providers."""
        http = self._get_http()
        params: dict[str, str] = {}
        if gpu_types:
            params["gpuTypes"] = ",".join(gpu_types)
        if region:
            params["region"] = region
        if provider:
            params["provider"] = provider
        if limit != 100:
            params["limit"] = str(limit)
        r = await http.get(
            "/v1/gpu/offers",
            params=params,
            timeout=30.0,
        )
        self._check_response(r, "/v1/gpu/offers")
        data = self._parse_json(r, "/v1/gpu/offers")
        offers = [
            GpuOffer(
                provider=o.get("provider", ""),
                gpu_type=o.get("gpuType", ""),
                gpu_name=o.get("gpuName", ""),
                available=o.get("available", 0),
                price_per_hr=o.get("pricePerHr", 0.0),
                region=o.get("region", ""),
                vram=o.get("vram", 0),
                offer_id=o.get("offerId", ""),
            )
            for o in data.get("offers", [])
        ]
        return GpuOffersResponse(
            offers=offers,
            providers=data.get("providers", []),
        )

    async def wait_for_gpu(
        self, poll_interval_s: float = 5.0, timeout_s: float = 20 * 60
    ) -> GpuStatus:
        """Wait for GPU to reach 'ready' status (polls gpu_status)."""
        import time
        start = time.monotonic()
        while time.monotonic() - start < timeout_s:
            status = await self.gpu_status()
            if status.status == "ready":
                return status
            if status.status == "error":
                raise GatewayError(status.message, 0, "/v1/gpu/status")
            if status.status == "idle":
                raise GatewayError("Deploy cancelled", 0, "/v1/gpu/status")
            await asyncio.sleep(poll_interval_s)
        raise GatewayError(
            f"GPU deploy timed out after {int(timeout_s / 60)} min",
            0, "/v1/gpu/status",
        )

    # ── Health ────────────────────────────────────────────────────────────

    async def health(self) -> bool:
        """Check if the gateway is reachable."""
        try:
            http = self._get_http()
            r = await http.get("/health", timeout=self._timeouts.health)
            return r.status_code == 200
        except Exception:
            return False

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def close(self) -> None:
        """Close the HTTP client and release resources."""
        with self._http_lock:
            http = self._http
            self._http = None
        if http and not http.is_closed:
            await http.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()

    # ── Internal ──────────────────────────────────────────────────────────

    def _check_response(self, r: httpx.Response, endpoint: str) -> None:
        if r.status_code >= 400:
            text = r.text[:200] if r.text else ""
            raise GatewayError(
                f"{endpoint} failed ({r.status_code}): {text}",
                status_code=r.status_code,
                endpoint=endpoint,
            )

    def _parse_json(self, r: httpx.Response, endpoint: str) -> dict:
        """Parse JSON response, raising GatewayError on invalid JSON."""
        try:
            return r.json()
        except (ValueError, TypeError) as e:
            raise GatewayError(
                f"{endpoint}: invalid JSON response: {e}",
                status_code=r.status_code,
                endpoint=endpoint,
            )
