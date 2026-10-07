"""
The model container, over HTTP on 127.0.0.1 only (`EDGE_UPSTREAM`). The edge never imports a model: any replica that
serves the OpenAI-shaped routes works (the speech-stack image does; so would separate Whisper / llama.cpp / Kokoro
servers behind one front).

    transcribe(pcm16k)            POST /v1/audio/transcriptions  (multipart WAV + language + prompt)
    chat_stream(messages, cfg)    POST /v1/chat/completions      (stream: true, SSE deltas)
    speak(text, cfg) → PCM        POST /v1/audio/speech          (stream: true, raw PCM s16le, or WAV whose header is read)
    partials (optional)           WS   /ws/audio-stream          (the speech-stack's incremental STT)
    s2s (EDGE_UPSTREAM_MODE=s2s)  POST /v1/s2s                   (one call per turn, framed events + PCM)
"""

import asyncio
import io
import json
import struct
import time
import wave

import aiohttp

from .config import Settings
from .telemetry import child_traceparent

LANGUAGE_NAMES = {"pt": "Portuguese", "fr": "French", "en": "English", "es": "Spanish", "it": "Italian", "de": "German"}


def wav_bytes(pcm16: bytes, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm16)
    return buf.getvalue()


class UpstreamError(RuntimeError):
    def __init__(self, stage: str, status: int | None, message: str):
        super().__init__(f"{stage} http {status}: {message}" if status else f"{stage}: {message}")
        self.stage, self.status = stage, status


def _headers(trace_id: str | None) -> dict:
    return {"traceparent": child_traceparent(trace_id)} if trace_id else {}


class Upstream:
    def __init__(self, settings: Settings):
        self.s = settings
        self.http: aiohttp.ClientSession | None = None
        self.ready = False
        self.voices: dict[str, dict] = {}
        self.voices_at = 0.0

    async def start(self) -> None:
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=5),
                                          connector=aiohttp.TCPConnector(limit=256))

    async def close(self) -> None:
        if self.http:
            await self.http.close()

    async def health_loop(self) -> None:
        while True:
            try:
                async with self.http.get(self.s.upstream + self.s.upstream_health, timeout=aiohttp.ClientTimeout(total=5)) as r:
                    self.ready = r.status == 200
            except Exception:  # noqa: BLE001 — not up yet
                self.ready = False
            await asyncio.sleep(5 if self.ready else 2)

    # ── STT ──────────────────────────────────────────────────────────────────

    async def transcribe(self, pcm16: bytes, language: str | None, prompt: str | None, trace_id: str | None = None) -> dict:
        form = aiohttp.FormData()
        form.add_field("file", wav_bytes(pcm16), filename="turn.wav", content_type="audio/wav")
        form.add_field("language", (language or "")[:2])
        if prompt:
            form.add_field("prompt", prompt)
        async with self.http.post(self.s.upstream + "/v1/audio/transcriptions", data=form, headers=_headers(trace_id)) as r:
            if r.status != 200:
                raise UpstreamError("stt", r.status, (await r.text())[:200])
            return await r.json(content_type=None)

    async def open_partials(self, language: str | None, trace_id: str | None = None):
        url = self.s.upstream.replace("http", "ws", 1) + f"/ws/audio-stream?language={(language or '')[:2]}&chunk_size=1.0"
        return await self.http.ws_connect(url, heartbeat=None, timeout=aiohttp.ClientWSTimeout(ws_close=2), headers=_headers(trace_id))

    # ── LLM ──────────────────────────────────────────────────────────────────

    async def chat_stream(self, messages: list[dict], cfg: dict, trace_id: str | None = None):
        body = {"model": self.s.llm_model, "messages": messages, "stream": True,
                "max_tokens": int(cfg.get("max_tokens", 160)), "temperature": float(cfg.get("temperature", 0.6)),
                "chat_template_kwargs": {"enable_thinking": False}}
        if cfg.get("response_format"):
            body["response_format"] = cfg["response_format"]
        async with self.http.post(self.s.upstream + "/v1/chat/completions", json=body, headers=_headers(trace_id)) as r:
            if r.status != 200:
                raise UpstreamError("llm", r.status, (await r.text())[:200])
            async for raw in r.content:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                choice = (json.loads(line[6:]).get("choices") or [{}])[0]
                delta = (choice.get("delta") or {}).get("content")
                if delta:
                    yield delta

    # ── TTS ──────────────────────────────────────────────────────────────────

    async def catalog(self) -> dict[str, dict]:
        if time.monotonic() - self.voices_at < 60:
            return self.voices
        try:
            async with self.http.get(self.s.upstream + "/v1/voices", timeout=aiohttp.ClientTimeout(total=5)) as r:
                if r.status == 200:
                    self.voices = {v["id"]: v for v in (await r.json(content_type=None)).get("voices", []) if "id" in v}
        except Exception:  # noqa: BLE001 — a replica without a catalog is fine (named voices go through as `voice`)
            pass
        self.voices_at = time.monotonic()
        return self.voices

    async def voice_fields(self, cfg: dict) -> dict:
        """Same semantics as the gateway's TTS: `voice` is a cast id (the replica's catalog: a cloning TTS gets its
        reference audio + transcript) or {audio, text}; an id the catalog does not know falls back to `fallback_voice`,
        sent as a plain named voice (Kokoro-style)."""
        voice, fallback = cfg.get("voice"), cfg.get("fallback_voice")
        if isinstance(voice, dict) and voice.get("audio") and voice.get("text"):
            return {"task_type": "Base", "ref_audio": voice["audio"], "ref_text": voice["text"]}
        voices = await self.catalog()
        if isinstance(voice, str) and voice in voices and voices[voice].get("text"):
            return {"task_type": "Base", "ref_audio": f"{self.s.ref_base}/refs/{voice}.wav", "ref_text": voices[voice]["text"]}
        if isinstance(voice, str) and (voice in voices or not fallback):
            return {"voice": voice}
        if fallback:
            return {"voice": fallback}
        raise ValueError("voice must be a catalog id, {audio, text}, or come with fallback_voice")

    async def speak(self, text: str, cfg: dict, fields: dict, trace_id: str | None = None):
        """Yields raw PCM s16le mono at `tts_rate` (a WAV answer's header is parsed and its rate reported once as int)."""
        lang = (cfg.get("language") or "pt")[:2]
        body = {"model": self.s.tts_model, "input": text, "language": LANGUAGE_NAMES.get(lang, "Portuguese"),
                "response_format": "pcm", "stream": True, "stream_format": "audio", **fields}
        async with self.http.post(self.s.upstream + "/v1/audio/speech", json=body, headers=_headers(trace_id)) as r:
            if r.status != 200:
                raise UpstreamError("tts", r.status, (await r.text())[:200])
            head = b""
            parsed = False
            async for chunk in r.content.iter_any():
                if not parsed:
                    head += chunk
                    if len(head) < 44:
                        continue
                    parsed = True
                    if head[:4] == b"RIFF":
                        yield struct.unpack("<I", head[24:28])[0]
                        at = head.find(b"data")
                        chunk = head[at + 8:] if at > 0 else head[44:]
                    else:
                        chunk = head
                if chunk:
                    yield chunk
            if not parsed and head:
                yield head

    # ── whole turn on the replica (/v1/s2s) ──────────────────────────────────

    async def s2s(self, pcm16: bytes, cfg: dict, trace_id: str | None = None):
        """Yields ("E", event dict) and ("A", PCM 24 kHz) in order, from the replica's framed /v1/s2s answer."""
        form = aiohttp.FormData()
        form.add_field("file", wav_bytes(pcm16), filename="turn.wav", content_type="audio/wav")
        form.add_field("config", json.dumps(cfg))
        async with self.http.post(self.s.upstream + "/v1/s2s", data=form, headers=_headers(trace_id)) as r:
            if r.status != 200:
                raise UpstreamError("s2s", r.status, (await r.text())[:200])
            while True:
                try:
                    head = await r.content.readexactly(5)
                except asyncio.IncompleteReadError:
                    return
                size = struct.unpack(">I", head[1:])[0]
                payload = await r.content.readexactly(size)
                kind = head[:1].decode()
                yield (kind, json.loads(payload) if kind == "E" else payload)
