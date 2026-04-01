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
import collections
import logging
import os
import threading
import time
from typing import Any, Callable, Awaitable, Optional

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
    RetryMode,
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
        self._race_config = race_config or RaceConfig()
        self._http: Optional[httpx.AsyncClient] = None
        self._groq_http: Optional[httpx.AsyncClient] = None
        self._http_lock = threading.Lock()
        self._groq_api_key = groq_api_key or os.environ.get("GROQ_API_KEY", "")
        self._adaptive_wins: collections.deque = collections.deque(maxlen=self._race_config.adaptive_window)

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

    async def _request_with_retry(self, method: str, url: str, **kwargs) -> httpx.Response:
        """Execute HTTP request with retry on connection errors and 429 rate limits.

        Retries on ConnectError, ConnectTimeout, ConnectionResetError, OSError.
        Also retries on HTTP 429 (rate limit) — respects the Retry-After header.
        Does NOT retry on other HTTP errors (4xx/5xx) or read/write timeouts.
        """
        last_err: BaseException | None = None
        max_attempts = 1 + len(self.RETRY_BACKOFF)
        for attempt in range(max_attempts):
            try:
                http = self._get_http()
                r = await getattr(http, method)(url, **kwargs)
                if r.status_code == 429 and attempt < max_attempts - 1:
                    delay = self._parse_retry_after(r, attempt)
                    log.warning("Rate limited (429) on %s, retry %d/%d after %.1fs", url, attempt + 1, len(self.RETRY_BACKOFF), delay)
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

    @staticmethod
    def _parse_retry_after(response: httpx.Response, attempt: int) -> float:
        """Parse Retry-After header, fall back to exponential backoff."""
        header = response.headers.get("retry-after", "")
        if header:
            try:
                delay = float(header)
                return min(delay, 30.0)  # cap at 30s
            except ValueError:
                pass
        # Fall back to exponential backoff
        backoff = GatewaySDK.RETRY_BACKOFF
        return backoff[min(attempt, len(backoff) - 1)]

    # ── Realtime N-way race ────────────────────────────────────────────────

    def _get_groq_http(self) -> httpx.AsyncClient:
        """Lazy-create the Groq direct HTTP client (thread-safe)."""
        with self._http_lock:
            if self._groq_http is None or self._groq_http.is_closed:
                self._groq_http = httpx.AsyncClient(
                    base_url=_GROQ_API_BASE,
                    headers={"Authorization": f"Bearer {self._groq_api_key}"},
                    timeout=5.0,
                )
            return self._groq_http

    def _record_win(self, provider: str):
        self._adaptive_wins.append(provider)

    def _adaptive_slots(self) -> list[str]:
        """Return wave_size provider slots biased by recent race winners."""
        cfg = self._race_config
        wins = dict(collections.Counter(self._adaptive_wins))
        groq_wins = wins.get("groq", 0)
        gw_wins = wins.get("gateway", 0)
        total_wins = groq_wins + gw_wins
        slots: list[str] = []
        if total_wins == 0:
            slots = ["gateway"] * (cfg.wave_size - 1) + (["groq"] if self._groq_api_key else ["gateway"])
        else:
            groq_ratio = groq_wins / total_wins
            groq_slots = round(groq_ratio * cfg.wave_size)
            gw_slots = cfg.wave_size - groq_slots
            if self._groq_api_key:
                slots = ["gateway"] * max(gw_slots, 1) + ["groq"] * max(groq_slots, 0)
            else:
                slots = ["gateway"] * cfg.wave_size
        while len(slots) < cfg.wave_size:
            slots.append("groq" if self._groq_api_key else "gateway")
        return slots[: cfg.wave_size]

    async def _race_wave(
        self,
        callables: list[tuple[Callable[[], Awaitable[Any]], str]],
        timeout_s: float,
    ) -> tuple[Any, str] | None:
        """Race N async callables, return (result, provider) of first success.

        Cancels all remaining tasks on first success or timeout.
        Returns None if all failed or timed out.
        """
        if not callables:
            return None

        tasks: dict[asyncio.Task, str] = {}
        for fn, name in callables:
            task = asyncio.ensure_future(fn())
            tasks[task] = name

        deadline = time.monotonic() + timeout_s
        pending: set[asyncio.Task] = set(tasks.keys())

        try:
            while pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break

                done, pending = await asyncio.wait(
                    pending,
                    timeout=remaining,
                    return_when=asyncio.FIRST_COMPLETED,
                )

                for task in done:
                    exc = task.exception()
                    if exc is None:
                        provider = tasks[task]
                        for t in pending | (done - {task}):
                            t.cancel()
                        return (task.result(), provider)
                    else:
                        log.debug("[race] %s failed: %s", tasks[task], exc)
        finally:
            for t in set(tasks.keys()):
                if not t.done():
                    t.cancel()

        return None

    async def _realtime_fetch(
        self,
        gateway_fn: Callable[[], Awaitable[Any]],
        groq_fn: Callable[[], Awaitable[Any]] | None,
        endpoint: str,
    ) -> Any:
        """Realtime N-way race with waves, fast-fail, and adaptive bias.

        Fires wave_size parallel requests per wave. Uses the first response.
        If all fail fast (<30% of wave_timeout), immediately launches next wave.
        Up to max_waves attempts.
        """
        cfg = self._race_config

        if cfg.mode == RetryMode.BATCH or groq_fn is None:
            return await gateway_fn()

        for wave in range(cfg.max_waves):
            slots = self._adaptive_slots()
            callables: list[tuple[Callable[[], Awaitable[Any]], str]] = []
            for slot in slots:
                if slot == "groq":
                    callables.append((groq_fn, "groq"))
                else:
                    callables.append((gateway_fn, "gateway"))

            t0 = time.monotonic()
            result = await self._race_wave(callables, cfg.wave_timeout_s)

            if result is not None:
                data, provider = result
                elapsed_ms = (time.monotonic() - t0) * 1000
                self._record_win(provider)
                log.info("[race] %s wave %d won by '%s' in %.0fms", endpoint, wave + 1, provider, elapsed_ms)
                return data

            elapsed = time.monotonic() - t0
            if elapsed < cfg.wave_timeout_s * 0.3:
                log.debug(
                    "[race] %s wave %d fast-failed (%.0fms), next wave immediately", endpoint, wave + 1, elapsed * 1000
                )
            else:
                log.warning(
                    "[race] %s wave %d timed out (%.0fms), launching wave %d/%d",
                    endpoint,
                    wave + 1,
                    elapsed * 1000,
                    wave + 2,
                    cfg.max_waves,
                )

        raise TimeoutError(f"{endpoint}: all {cfg.max_waves} race waves failed")

    # ── Inference ─────────────────────────────────────────────────────────

    async def transcribe(self, audio: bytes, language: str = "fr", prompt: str = "") -> TranscribeResponse:
        """Transcribe audio to text (GPU-aware routing).

        In REALTIME mode: races gateway + Groq direct, first response wins.
        In BATCH mode: sequential with retry backoff + Groq fallback.
        """
        if self._race_config.mode == RetryMode.BATCH or not self._groq_api_key:
            return await self._transcribe_batch(audio, language, prompt)

        async def _gateway():
            params: dict[str, str] = {"language": language}
            if prompt:
                params["prompt"] = prompt
            r = await self._request_with_retry(
                "post",
                "/v1/transcribe",
                content=audio,
                params=params,
                headers={"Content-Type": "audio/wav"},
                timeout=self._timeouts.stt,
            )
            self._check_response(r, "/v1/transcribe")
            data = self._parse_json(r, "/v1/transcribe")
            return TranscribeResponse(
                text=data.get("text", ""),
                used_gpu=data.get("used_gpu", False),
                detected_language=data.get("language", ""),
                avg_logprob=data.get("avg_logprob", 0.0),
            )

        async def _groq():
            return await self._groq_transcribe(audio, language, prompt)

        return await self._realtime_fetch(_gateway, _groq, "/v1/transcribe")

    async def _transcribe_batch(self, audio: bytes, language: str, prompt: str) -> TranscribeResponse:
        """BATCH mode: sequential gateway request with Groq fallback."""
        try:
            params: dict[str, str] = {"language": language}
            if prompt:
                params["prompt"] = prompt
            r = await self._request_with_retry(
                "post",
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

        In REALTIME mode: races gateway ensemble + Groq direct, first response wins.
        In BATCH mode: sequential with Groq fallback.

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

        if self._race_config.mode == RetryMode.BATCH or not self._groq_api_key:
            return await self._ensemble_batch(audio, language, prompt, timeout_ms, providers, llm_correct)

        async def _gateway():
            return await self._ensemble_batch(audio, language, prompt, timeout_ms, providers, llm_correct)

        async def _groq():
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

        return await self._realtime_fetch(_gateway, _groq, "/v1/transcribe/ensemble")

    async def _ensemble_batch(
        self,
        audio: bytes,
        language: str,
        prompt: str,
        timeout_ms: int,
        providers: list[str] | None,
        llm_correct: bool,
    ) -> "EnsembleTranscribeResponse":
        """BATCH mode: sequential gateway ensemble with Groq fallback."""
        from gateway_sdk.types import EnsembleTranscribeResponse

        try:
            params: dict[str, str] = {"language": language, "timeout_ms": str(timeout_ms)}
            if prompt:
                params["prompt"] = prompt
            if providers:
                params["providers"] = ",".join(providers)
            if llm_correct:
                params["llm_correct"] = "true"
            http_timeout = timeout_ms / 1000 + 5.0
            r = await self._request_with_retry(
                "post",
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

    async def translate(self, text: str, source_lang: str, target_lang: str, context: str = "") -> TranslateResponse:
        """Translate text (GPU-aware routing).

        Args:
            context: Current session/event context to improve translation accuracy.
        """
        if not text.strip():
            return TranslateResponse(translated_text="", used_gpu=False)

        body: dict = {"text": text, "source_lang": source_lang, "target_lang": target_lang}
        if context:
            body["context"] = context
        r = await self._request_with_retry(
            "post",
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

        r = await self._request_with_retry(
            "post",
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

        In REALTIME mode: races gateway + Groq direct, first response wins.
        In BATCH mode: sequential with Groq fallback.
        """
        if self._race_config.mode == RetryMode.BATCH or not self._groq_api_key:
            return await self._chat_batch(messages, model, temperature, max_tokens)

        async def _gateway():
            return await self._chat_batch(messages, model, temperature, max_tokens)

        async def _groq():
            return await self._groq_chat(messages, model, temperature, max_tokens)

        return await self._realtime_fetch(_gateway, _groq, "/v1/chat/completions")

    async def _chat_batch(
        self,
        messages: list[dict],
        model: str = "llama-3.3-70b-versatile",
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> ChatCompletionResponse:
        """BATCH mode: sequential gateway chat with Groq fallback."""
        body: dict = {"model": model, "messages": messages}
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        try:
            r = await self._request_with_retry(
                "post",
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
        log.warning("Groq STT direct fallback")
        client = self._get_groq_http()
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
        self,
        messages: list[dict],
        model: str,
        temperature: float | None,
        max_tokens: int | None,
    ) -> ChatCompletionResponse:
        """Call Groq LLM directly when gateway is unreachable."""
        log.warning("Groq LLM direct fallback")
        client = self._get_groq_http()
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
        r = await self._request_with_retry("get", "/v1/config/api-keys", timeout=self._timeouts.health)
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
        r = await self._request_with_retry(
            "post", "/v1/config/api-keys", json={"keys": keys}, timeout=self._timeouts.health
        )
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
        r = await self._request_with_retry("get", "/v1/config/providers", timeout=self._timeouts.health)
        self._check_response(r, "/v1/config/providers")
        data = self._parse_json(r, "/v1/config/providers")
        return ProviderConfigResponse(
            profiles=[
                ProviderProfile(
                    id=p["id"],
                    name=p["name"],
                    stt=[PipelineChainEntry(**s) for s in p.get("stt", [])],
                    llm=[PipelineChainEntry(**l) for l in p.get("llm", [])],
                    tts=[PipelineChainEntry(**t) for t in p.get("tts", [])],
                )
                for p in data.get("profiles", [])
            ],
            active_profile_id=data.get("activeProfileId"),
            pipeline_stt=[PipelineChainEntry(**s) for s in data.get("pipelineStt", [])],
            pipeline_llm=[PipelineChainEntry(**l) for l in data.get("pipelineLlm", [])],
            pipeline_tts=[PipelineChainEntry(**t) for t in data.get("pipelineTts", [])],
            updated_at=data.get("updatedAt", 0),
        )

    async def patch_provider_config(self, partial: dict) -> ProviderConfigResponse:
        """Patch (merge) provider pipeline configuration on the gateway."""
        r = await self._request_with_retry("post", "/v1/config/providers", json=partial, timeout=self._timeouts.health)
        self._check_response(r, "/v1/config/providers")
        data = self._parse_json(r, "/v1/config/providers")
        return ProviderConfigResponse(
            profiles=[
                ProviderProfile(
                    id=p["id"],
                    name=p["name"],
                    stt=[PipelineChainEntry(**s) for s in p.get("stt", [])],
                    llm=[PipelineChainEntry(**l) for l in p.get("llm", [])],
                    tts=[PipelineChainEntry(**t) for t in p.get("tts", [])],
                )
                for p in data.get("profiles", [])
            ],
            active_profile_id=data.get("activeProfileId"),
            pipeline_stt=[PipelineChainEntry(**s) for s in data.get("pipelineStt", [])],
            pipeline_llm=[PipelineChainEntry(**l) for l in data.get("pipelineLlm", [])],
            pipeline_tts=[PipelineChainEntry(**t) for t in data.get("pipelineTts", [])],
            updated_at=data.get("updatedAt", 0),
        )

    async def catalog(self) -> CatalogResponse:
        """Get the full provider/model/voice catalog from the gateway playground."""
        r = await self._request_with_retry("get", "/v1/playground/catalog", timeout=self._timeouts.health)
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

        r = await self._request_with_retry(
            "post",
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
        r = await self._request_with_retry("get", "/v1/gpu/status", timeout=self._timeouts.health)
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
        r = await self._request_with_retry(
            "post",
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
        r = await self._request_with_retry(
            "get",
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
        r = await self._request_with_retry("get", "/v1/gpu/logs", timeout=self._timeouts.deploy)
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

    async def wait_for_gpu(self, poll_interval_s: float = 5.0, timeout_s: float = 20 * 60) -> GpuStatus:
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
            0,
            "/v1/gpu/status",
        )

    # ── Observability ────────────────────────────────────────────────────

    async def request_log(self, since_id: int = 0, limit: int = 50) -> RequestLogResponse:
        """Fetch request log entries and aggregate stats."""
        params: dict[str, str] = {}
        if since_id > 0:
            params["since_id"] = str(since_id)
        if limit != 50:
            params["limit"] = str(limit)
        r = await self._request_with_retry(
            "get",
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
        r = await self._request_with_retry("get", "/metrics", timeout=self._timeouts.health)
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
            r = await self._request_with_retry("get", "/health", timeout=self._timeouts.health)
            return r.status_code == 200
        except Exception:
            return False

    async def health_detail(self) -> HealthResponse:
        """Fetch detailed health info (components, providers, GPU state)."""
        r = await self._request_with_retry("get", "/health", timeout=self._timeouts.health)
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
