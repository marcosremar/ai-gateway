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
import os
import threading
from typing import Optional

import httpx

from gateway_sdk.types import (
    ApiKeyEntry,
    ApiKeysResponse,
    CatalogProvider,
    CatalogResponse,
    ChatCompletionResponse,
    GatewayConfig,
    GatewayError,
    GpuOffer,
    GpuOffersResponse,
    GpuLogsResponse,
    HealthResponse,
    MetricsResponse,
    PipelineChainEntry,
    ProviderConfigResponse,
    ProviderProfile,
    RaceConfig,
    RequestLogEntry,
    RequestLogResponse,
    RequestLogStats,
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


_RETRYABLE_ERRORS = (httpx.ConnectError, httpx.ConnectTimeout, ConnectionResetError, OSError)

_GROQ_API_BASE = "https://api.groq.com/openai/v1"


class GatewaySDK:
    """Async HTTP client for the BabelCast AI Gateway.

    All inference methods are GPU-aware — the gateway routes to GPU pod
    when available, falls back to cloud (Groq) automatically.

    Retries connection errors (ConnectError, ConnectTimeout, ConnectionReset,
    OSError) with exponential backoff. HTTP errors (4xx, 5xx) and read/write
    timeouts are NOT retried.
    """

    RETRY_BACKOFF = [0.5, 1.0, 2.0, 4.0]  # seconds between retries (4 retries = 5 total attempts)

    def __init__(
        self,
        base_url: str = "http://localhost:4000",
        api_key: str = "",
        timeouts: Optional[Timeouts] = None,
        groq_api_key: str = "",
        race_config: Optional[RaceConfig] = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeouts = timeouts or Timeouts()
        self._http: Optional[httpx.AsyncClient] = None
        self._http_lock = threading.Lock()
        self._groq_api_key = groq_api_key or os.environ.get("GROQ_API_KEY", "")
        self._race_config: Optional[RaceConfig] = race_config

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

    # ── Retry wrapper ──────────────────────────────────────────────────────

    @staticmethod
    def _parse_retry_after(response: httpx.Response, attempt: int) -> float:
        """Parse Retry-After header; fall back to RETRY_BACKOFF on invalid/missing."""
        header = response.headers.get("Retry-After", "")
        try:
            delay = float(header)
            return min(delay, 30.0)
        except (ValueError, TypeError):
            idx = min(attempt, len(GatewaySDK.RETRY_BACKOFF) - 1)
            return GatewaySDK.RETRY_BACKOFF[idx]

    async def _request_with_retry(self, method: str, url: str, **kwargs) -> httpx.Response:
        """Execute HTTP request with retry on connection errors and 429 responses.

        Retries on ConnectError, ConnectTimeout, ConnectionResetError, OSError, and 429.
        Does NOT retry on other HTTP errors (4xx/5xx) or read/write timeouts.
        """
        last_err: BaseException | None = None
        for attempt in range(1 + len(self.RETRY_BACKOFF)):
            try:
                http = self._get_http()
                r = await getattr(http, method)(url, **kwargs)
                if r.status_code == 429 and attempt < len(self.RETRY_BACKOFF):
                    delay = self._parse_retry_after(r, attempt)
                    log.debug("429 rate-limited; retrying in %.2fs (attempt %d)", delay, attempt + 1)
                    await asyncio.sleep(delay)
                    continue
                return r
            except _RETRYABLE_ERRORS as e:
                last_err = e
                if attempt < len(self.RETRY_BACKOFF):
                    delay = self.RETRY_BACKOFF[attempt]
                    log.debug("Retry %d/%d after %s: %s", attempt + 1, len(self.RETRY_BACKOFF), type(e).__name__, e)
                    await asyncio.sleep(delay)
                else:
                    raise

        raise last_err  # unreachable, but satisfies type checker

    # ── Inference ─────────────────────────────────────────────────────────

    async def transcribe(self, audio: bytes, language: str = "fr", prompt: str = "") -> TranscribeResponse:
        """Transcribe audio to text (GPU-aware routing).

        When race_config is set, launches parallel wave races across gateway
        and Groq providers. Otherwise falls back to Groq on connection error.

        Args:
            prompt: Previous transcription text for Whisper context (initial_prompt).
        """
        if self._race_config is not None:
            return await self._transcribe_race(audio, language, prompt)

        try:
            params: dict[str, str] = {"language": language}
            if prompt:
                params["prompt"] = prompt
            r = await self._request_with_retry("post",
                "/v1/transcribe",
                content=audio,
                params=params,
                headers={"Content-Type": "audio/wav"},
                timeout=self._timeouts.stt,
            )
        except _RETRYABLE_ERRORS:
            if not self._groq_api_key:
                raise
            return await self._groq_transcribe(audio, language, prompt)
        self._check_response(r, "/v1/transcribe")
        data = self._parse_json(r, "/v1/transcribe")
        return TranscribeResponse(
            text=data.get("text", ""),
            used_gpu=data.get("used_gpu", False),
            detected_language=data.get("language", ""),
            avg_logprob=data.get("avg_logprob", 0.0),
        )

    async def _transcribe_race(self, audio: bytes, language: str, prompt: str) -> TranscribeResponse:
        """Wave-racing transcription: parallel requests across providers per wave."""
        rc = self._race_config
        assert rc is not None

        async def _gw() -> TranscribeResponse:
            params: dict[str, str] = {"language": language}
            if prompt:
                params["prompt"] = prompt
            r = await self._request_with_retry("post", "/v1/transcribe",
                content=audio, params=params,
                headers={"Content-Type": "audio/wav"},
                timeout=self._timeouts.stt,
            )
            self._check_response(r, "/v1/transcribe")
            d = self._parse_json(r, "/v1/transcribe")
            return TranscribeResponse(
                text=d.get("text", ""),
                used_gpu=d.get("used_gpu", False),
                detected_language=d.get("language", ""),
                avg_logprob=d.get("avg_logprob", 0.0),
            )

        providers = [_gw]
        if self._groq_api_key:
            providers.append(lambda: self._groq_transcribe(audio, language, prompt))

        n_slots = min(rc.wave_size, len(providers))

        for wave_idx in range(rc.max_waves):
            wave_coros = [p() for p in providers[:n_slots]]
            try:
                results = await asyncio.wait_for(
                    asyncio.gather(*wave_coros, return_exceptions=True),
                    timeout=rc.wave_timeout_s,
                )
            except asyncio.TimeoutError:
                continue

            for result in results:
                if not isinstance(result, BaseException):
                    return result

        raise TimeoutError(f"all {rc.max_waves} race waves failed")

    async def transcribe_ensemble(
        self,
        audio: bytes,
        language: str = "fr",
        prompt: str = "",
        timeout_ms: int = 1500,
        providers: list[str] | None = None,
        llm_correct: bool = False,
    ) -> "EnsembleTranscribeResponse":
        """Transcribe audio using all configured STT providers; consensus via similarity.

        Args:
            timeout_ms: Per-provider deadline in ms. Providers that miss it are dropped
                        and consensus is built from whoever arrived in time.
                        Default 1500ms — keeps the subtitle pipeline responsive.
            providers: Subset of providers to use, e.g. ["groq", "openai"].
                       None = use gateway default (ENSEMBLE_STT_PROVIDERS env var).
            llm_correct: When True, runs an LLM pass to fix proper names and obvious
                         errors after the consensus vote. Adds ~300ms. Returns
                         .corrected and .correction_applied in the response.

        Returns EnsembleTranscribeResponse with .consensus (best text) and .providers dict.
        """
        from gateway_sdk.types import EnsembleTranscribeResponse
        try:
            params: dict[str, str] = {"language": language, "timeout_ms": str(timeout_ms)}
            if prompt:
                params["prompt"] = prompt
            if providers:
                params["providers"] = ",".join(providers)
            if llm_correct:
                params["llm_correct"] = "true"
            # HTTP timeout = provider deadline + similarity overhead + network buffer
            http_timeout = timeout_ms / 1000 + 5.0
            r = await self._request_with_retry("post",
                "/v1/transcribe/ensemble",
                content=audio,
                params=params,
                headers={"Content-Type": "audio/wav"},
                timeout=http_timeout,
            )
        except _RETRYABLE_ERRORS:
            if not self._groq_api_key:
                raise
            stt = await self._groq_transcribe(audio, language, prompt)
            return EnsembleTranscribeResponse(
                consensus=stt.text,
                providers={"groq": stt.text},
                used_providers=1,
                latency_ms=0,
                scores={},
                outliers=[],
                similarity_method="none",
                embedding_provider="",
                corrected="",
                correction_applied=False,
            )
        self._check_response(r, "/v1/transcribe/ensemble")
        data = self._parse_json(r, "/v1/transcribe/ensemble")
        return EnsembleTranscribeResponse(
            consensus=data.get("consensus", ""),
            providers=data.get("providers", {}),
            used_providers=data.get("used_providers", 0),
            latency_ms=data.get("latency_ms", 0),
            scores=data.get("scores", {}),
            outliers=data.get("outliers", []),
            similarity_method=data.get("similarity_method", "jaccard"),
            embedding_provider=data.get("embedding_provider", ""),
            corrected=data.get("corrected", ""),
            correction_applied=data.get("correction_applied", False),
        )

    async def translate(
        self, text: str, source_lang: str, target_lang: str,
        context: str = ""
    ) -> TranslateResponse:
        """Translate text (GPU-aware routing).

        Args:
            context: Current session/event context to improve translation accuracy.
        """
        if not text.strip():
            return TranslateResponse(translated_text="", used_gpu=False)

        body: dict = {"text": text, "source_lang": source_lang, "target_lang": target_lang}
        if context:
            body["context"] = context
        r = await self._request_with_retry("post",
            "/v1/translate",
            json=body,
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
        # Voice cloning: ref_id (cached on gateway) preferred over inline ref_audio
        if opts.ref_id:
            params["ref_id"] = opts.ref_id
        headers: dict[str, str] = {"Content-Type": "audio/wav"}
        if opts.reference_audio and not opts.ref_id:
            headers["X-Reference-Audio"] = opts.reference_audio
        if opts.ref_text and not opts.ref_id:
            import urllib.parse
            headers["X-Ref-Text"] = urllib.parse.quote(opts.ref_text[:500], safe="")

        r = await self._request_with_retry("post",
            "/v1/speech",
            content=audio,
            params=params,
            headers=headers,
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

    async def chat(
        self,
        messages: list[dict],
        model: str = "llama-3.3-70b-versatile",
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> ChatCompletionResponse:
        """Send a chat completion request through the gateway.

        Falls back to Groq LLM directly when the gateway is unreachable
        and groq_api_key is configured.

        Supports text and vision (multimodal content arrays).
        The gateway routes to the configured LLM provider.
        """
        try:
            body: dict = {"model": model, "messages": messages}
            if temperature is not None:
                body["temperature"] = temperature
            if max_tokens is not None:
                body["max_tokens"] = max_tokens
            r = await self._request_with_retry("post",
                "/v1/chat/completions",
                json=body,
                timeout=self._timeouts.translate,
            )
        except _RETRYABLE_ERRORS:
            if not self._groq_api_key:
                raise
            return await self._groq_chat(messages, model, temperature, max_tokens)
        self._check_response(r, "/v1/chat/completions")
        data = self._parse_json(r, "/v1/chat/completions")
        content = ""
        choices = data.get("choices", [])
        if choices:
            content = choices[0].get("message", {}).get("content", "")
        return ChatCompletionResponse(
            content=content,
            model=data.get("model", model),
            usage=data.get("usage"),
        )

    # ── Groq direct fallback ────────────────────────────────────────────────

    async def _groq_transcribe(self, audio: bytes, language: str, prompt: str) -> TranscribeResponse:
        """Call Groq Whisper directly when gateway is unreachable."""
        log.warning("Gateway unreachable — falling back to Groq STT")
        async with httpx.AsyncClient(
            base_url=_GROQ_API_BASE,
            headers={"Authorization": f"Bearer {self._groq_api_key}"},
            timeout=self._timeouts.stt,
        ) as client:
            data: dict[str, str] = {"model": "whisper-large-v3-turbo", "language": language}
            if prompt:
                data["prompt"] = prompt
            r = await client.post(
                "/audio/transcriptions",
                data=data,
                files={"file": ("audio.wav", audio, "audio/wav")},
            )
        if r.status_code >= 400:
            raise GatewayError(
                f"Groq STT fallback failed ({r.status_code}): {r.text[:200]}",
                status_code=r.status_code,
                endpoint="groq:/audio/transcriptions",
            )
        result = r.json()
        return TranscribeResponse(
            text=result.get("text", ""),
            used_gpu=False,
            detected_language=language,
            avg_logprob=0.0,
        )

    async def _groq_chat(
        self, messages: list[dict], model: str,
        temperature: float | None, max_tokens: int | None,
    ) -> ChatCompletionResponse:
        """Call Groq LLM directly when gateway is unreachable."""
        log.warning("Gateway unreachable — falling back to Groq LLM")
        async with httpx.AsyncClient(
            base_url=_GROQ_API_BASE,
            headers={"Authorization": f"Bearer {self._groq_api_key}"},
            timeout=self._timeouts.translate,
        ) as client:
            body: dict = {"model": model, "messages": messages}
            if temperature is not None:
                body["temperature"] = temperature
            if max_tokens is not None:
                body["max_tokens"] = max_tokens
            r = await client.post("/chat/completions", json=body)
        if r.status_code >= 400:
            raise GatewayError(
                f"Groq LLM fallback failed ({r.status_code}): {r.text[:200]}",
                status_code=r.status_code,
                endpoint="groq:/chat/completions",
            )
        data = r.json()
        content = ""
        choices = data.get("choices", [])
        if choices:
            content = choices[0].get("message", {}).get("content", "")
        return ChatCompletionResponse(
            content=content,
            model=data.get("model", model),
            usage=data.get("usage"),
        )

    # ── Config & catalog ──────────────────────────────────────────────────

    async def get_api_keys(self) -> ApiKeysResponse:
        """Get configured API keys (masked) from the gateway."""
        r = await self._request_with_retry("get","/v1/config/api-keys", timeout=self._timeouts.health)
        self._check_response(r, "/v1/config/api-keys")
        data = self._parse_json(r, "/v1/config/api-keys")
        def _norm_key_entry(k: dict) -> ApiKeyEntry:
            k = dict(k)
            if "envVar" in k:
                k["env_var"] = k.pop("envVar")
            return ApiKeyEntry(**k)
        keys = [_norm_key_entry(k) for k in data.get("keys", data if isinstance(data, list) else [])]
        return ApiKeysResponse(keys=keys)

    async def set_api_keys(self, keys: dict[str, str]) -> ApiKeysResponse:
        """Update API keys on the gateway (persisted to .env)."""
        r = await self._request_with_retry("post","/v1/config/api-keys", json={"keys": keys}, timeout=self._timeouts.health)
        self._check_response(r, "/v1/config/api-keys")
        data = self._parse_json(r, "/v1/config/api-keys")
        def _norm(k: dict) -> ApiKeyEntry:
            k = dict(k)
            if "envVar" in k:
                k["env_var"] = k.pop("envVar")
            return ApiKeyEntry(**k)
        entries = [_norm(k) for k in data.get("keys", [])]
        return ApiKeysResponse(keys=entries, saved=data.get("saved", False))

    async def get_provider_config(self) -> ProviderConfigResponse:
        """Get provider pipeline configuration from the gateway."""
        r = await self._request_with_retry("get","/v1/config/providers", timeout=self._timeouts.health)
        self._check_response(r, "/v1/config/providers")
        data = self._parse_json(r, "/v1/config/providers")
        return ProviderConfigResponse(
            profiles=[ProviderProfile(
                id=p["id"], name=p["name"],
                stt=[PipelineChainEntry(**s) for s in p.get("stt", [])],
                llm=[PipelineChainEntry(**l) for l in p.get("llm", [])],
                tts=[PipelineChainEntry(**t) for t in p.get("tts", [])],
            ) for p in data.get("profiles", [])],
            active_profile_id=data.get("activeProfileId"),
            pipeline_stt=[PipelineChainEntry(**s) for s in data.get("pipelineStt", [])],
            pipeline_llm=[PipelineChainEntry(**l) for l in data.get("pipelineLlm", [])],
            pipeline_tts=[PipelineChainEntry(**t) for t in data.get("pipelineTts", [])],
            updated_at=data.get("updatedAt", 0),
        )

    async def patch_provider_config(self, partial: dict) -> ProviderConfigResponse:
        """Patch (merge) provider pipeline configuration on the gateway."""
        r = await self._request_with_retry("post","/v1/config/providers", json=partial, timeout=self._timeouts.health)
        self._check_response(r, "/v1/config/providers")
        data = self._parse_json(r, "/v1/config/providers")
        return ProviderConfigResponse(
            profiles=[ProviderProfile(
                id=p["id"], name=p["name"],
                stt=[PipelineChainEntry(**s) for s in p.get("stt", [])],
                llm=[PipelineChainEntry(**l) for l in p.get("llm", [])],
                tts=[PipelineChainEntry(**t) for t in p.get("tts", [])],
            ) for p in data.get("profiles", [])],
            active_profile_id=data.get("activeProfileId"),
            pipeline_stt=[PipelineChainEntry(**s) for s in data.get("pipelineStt", [])],
            pipeline_llm=[PipelineChainEntry(**l) for l in data.get("pipelineLlm", [])],
            pipeline_tts=[PipelineChainEntry(**t) for t in data.get("pipelineTts", [])],
            updated_at=data.get("updatedAt", 0),
        )

    async def catalog(self) -> CatalogResponse:
        """Get the full provider/model/voice catalog from the gateway playground."""
        r = await self._request_with_retry("get","/v1/playground/catalog", timeout=self._timeouts.health)
        self._check_response(r, "/v1/playground/catalog")
        data = self._parse_json(r, "/v1/playground/catalog")
        return CatalogResponse(
            providers=[CatalogProvider(**p) for p in data.get("providers", [])],
            capabilities=data.get("capabilities", {}),
            gpu=data.get("gpu", {}),
            defaults=data.get("defaults", {}),
            languages=data.get("languages", []),
        )

    # ── GPU management ────────────────────────────────────────────────────

    async def deploy_gpu(self, options: DeployOptions) -> DeployResponse:
        """Deploy a GPU pod (non-blocking — returns immediately, poll gpu_status())."""
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
        if options.interruptible is not None:
            body["interruptible"] = options.interruptible
        if options.race_count > 0:
            body["raceCount"] = options.race_count
        if options.provider:
            body["provider"] = options.provider

        r = await self._request_with_retry("post",
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
        r = await self._request_with_retry("get","/v1/gpu/status", timeout=self._timeouts.health)
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
            boot_on_startup=d.get("bootOnStartup", False),
        )

    async def terminate_gpu(self, api_key: str) -> None:
        """Terminate the GPU pod."""
        r = await self._request_with_retry("post",
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
        params: dict[str, str] = {}
        if gpu_types:
            params["gpuTypes"] = ",".join(gpu_types)
        if region:
            params["region"] = region
        if provider:
            params["provider"] = provider
        if limit != 100:
            params["limit"] = str(limit)
        r = await self._request_with_retry("get",
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
                spot_price_per_hr=o.get("spotPricePerHr", 0.0),
            )
            for o in data.get("offers", [])
        ]
        return GpuOffersResponse(
            offers=offers,
            providers=data.get("providers", []),
        )

    async def cancel_deploy(self, api_key: str) -> None:
        """Cancel an in-progress GPU deploy (alias for terminate_gpu)."""
        await self.terminate_gpu(api_key)

    async def gpu_logs(self) -> GpuLogsResponse:
        """Fetch recent GPU pod logs via SSH proxy."""
        r = await self._request_with_retry("get","/v1/gpu/logs", timeout=self._timeouts.deploy)
        self._check_response(r, "/v1/gpu/logs")
        d = self._parse_json(r, "/v1/gpu/logs")
        return GpuLogsResponse(
            logs=d.get("logs", ""),
            ssh_host=d.get("sshHost", ""),
            ssh_port=d.get("sshPort", 0),
            endpoint=d.get("endpoint", ""),
            pod_id=d.get("podId", ""),
            provider=d.get("provider", ""),
            status=d.get("status", ""),
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

    # ── Observability ────────────────────────────────────────────────────

    async def request_log(
        self, since_id: int = 0, limit: int = 50
    ) -> RequestLogResponse:
        """Fetch request log entries and aggregate stats."""
        params: dict[str, str] = {}
        if since_id > 0:
            params["since_id"] = str(since_id)
        if limit != 50:
            params["limit"] = str(limit)
        r = await self._request_with_retry("get",
            "/v1/requests/log",
            params=params,
            timeout=self._timeouts.health,
        )
        self._check_response(r, "/v1/requests/log")
        data = self._parse_json(r, "/v1/requests/log")
        entries = [
            RequestLogEntry(
                id=e.get("id", 0),
                timestamp=e.get("timestamp", 0),
                stage=e.get("stage", ""),
                provider=e.get("provider", ""),
                model=e.get("model", ""),
                latency_ms=e.get("latencyMs", 0),
                success=e.get("success", True),
                error=e.get("error", ""),
                input_size=e.get("inputSize", 0),
                output_preview=e.get("outputPreview", ""),
            )
            for e in data.get("entries", [])
        ]
        s = data.get("stats", {})
        stats = RequestLogStats(
            total_requests=s.get("totalRequests", 0),
            gpu_requests=s.get("gpuRequests", 0),
            cloud_requests=s.get("cloudRequests", 0),
            total_latency_ms=s.get("totalLatencyMs", 0),
            avg_latency_ms=s.get("avgLatencyMs", 0),
            gpu_percent=s.get("gpuPercent", 0),
            errors=s.get("errors", 0),
            by_stage=s.get("byStage", {}),
        )
        return RequestLogResponse(entries=entries, stats=stats)

    async def metrics(self) -> MetricsResponse:
        """Fetch gateway metrics (request counts, latency percentiles, etc.)."""
        r = await self._request_with_retry("get","/metrics", timeout=self._timeouts.health)
        self._check_response(r, "/metrics")
        d = self._parse_json(r, "/metrics")
        return MetricsResponse(
            requests_total=d.get("requestsTotal", 0),
            requests_by_stage=d.get("requestsByStage", {}),
            requests_by_provider=d.get("requestsByProvider", {}),
            errors_total=d.get("errorsTotal", 0),
            db_log_failures=d.get("dbLogFailures", 0),
            latency_p50_ms=d.get("latencyP50Ms", 0),
            latency_p95_ms=d.get("latencyP95Ms", 0),
            latency_p99_ms=d.get("latencyP99Ms", 0),
            gpu_status=d.get("gpuStatus", "idle"),
            uptime_sec=d.get("uptimeSec", 0),
        )

    # ── Health ────────────────────────────────────────────────────────────

    async def health(self) -> bool:
        """Check if the gateway is reachable."""
        try:
            r = await self._request_with_retry("get","/health", timeout=self._timeouts.health)
            return r.status_code == 200
        except Exception:
            return False

    async def health_detail(self) -> HealthResponse:
        """Fetch detailed health info (components, providers, GPU state)."""
        r = await self._request_with_retry("get","/health", timeout=self._timeouts.health)
        self._check_response(r, "/health")
        d = self._parse_json(r, "/health")
        return HealthResponse(
            status=d.get("status", "ok"),
            uptime_sec=d.get("uptime_sec", 0),
            gpu=d.get("gpu", "idle"),
            providers=d.get("providers", {}),
            components=d.get("components", {}),
            reason=d.get("reason", ""),
        )

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
