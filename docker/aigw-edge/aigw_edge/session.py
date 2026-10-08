"""
One learner's realtime session, independent of the transport (WebRTC or WebSocket):

    PCM16 16 kHz in ─► VAD (server) / end_turn (client) ─► turn audio ─► STT (+ partials) ─► hallucination guard
        ─► LLM stream (reply_delta) ─► sentence cutter ─► TTS per sentence (≤ EDGE_TTS_PARALLEL ahead, in order)
        ─► AudioOut (PCM16 24 kHz) ─► transport (Opus over WebRTC, or 20 ms binary frames over WS)

Barge-in: learner speech (server VAD) or `interrupt` while a turn is thinking or speaking cancels the LLM/TTS calls,
drops the queued audio and emits `interrupted`. History (`messages`) grows by one user + one assistant message per turn
(the assistant part is what was generated before an interruption); `config_update{messages}` appends to it.
"""

import asyncio
import collections
import time

import numpy as np

from . import opener
from .config import MAX_FIRST_AUDIO_DEADLINE_MS, Settings
from .hallucination import filter_transcript
from .text import JsonField, cut
from .telemetry import new_trace_id, telemetry
from .upstream import Upstream, UpstreamError
from .vad import FRAME_SAMPLES, EnergyVad, load_silero

OUT_RATE = 24000
OUT_FRAME_BYTES = OUT_RATE // 50 * 2  # 20 ms of PCM16 mono at 24 kHz
PRE_ROLL_FRAMES = 15  # 300 ms kept before the VAD opened a turn (its first syllable is quieter than the gate)
MIN_TURN_BYTES = int(0.3 * 16000) * 2
OUT_BYTES_PER_MS = OUT_RATE * 2 // 1000
recent_first_audio: collections.deque = collections.deque(maxlen=512)


def first_audio_max(window_s: float) -> int | None:
    since = time.monotonic() - window_s
    return max((ms for at, ms in recent_first_audio if at >= since), default=None)


def resample_pcm16(pcm: bytes, src: int, dst: int) -> bytes:
    if src == dst or not pcm:
        return pcm
    x = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype=np.int16).astype(np.float32)
    n = int(round(len(x) * dst / src))
    y = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
    return np.clip(y, -32768, 32767).astype(np.int16).tobytes()


def ms_between(start: float | None, end: float) -> int | None:
    return round((end - start) * 1000) if start else None


def ttfa_from_speech(metrics: dict, key: str = "ttfa_ms") -> int | None:
    if metrics["endpoint_ms"] is None or metrics[key] is None:
        return None
    return metrics["endpoint_ms"] + metrics[key]


class AudioOut:
    """PCM16 24 kHz waiting to be played; the transport pulls 20 ms frames at real time."""

    def __init__(self):
        self.buf = bytearray()
        self.drained = asyncio.Event()
        self.drained.set()

    def push(self, pcm: bytes) -> None:
        if pcm:
            self.buf += pcm
            self.drained.clear()

    def clear(self) -> None:
        self.buf.clear()
        self.drained.set()

    def pull(self, size: int = OUT_FRAME_BYTES) -> bytes | None:
        if not self.buf:
            self.drained.set()
            return None
        chunk = bytes(self.buf[:size])
        del self.buf[:size]
        if not self.buf:
            self.drained.set()
        return chunk + b"\0" * (size - len(chunk))


class Session:
    def __init__(self, sid: str, claims: dict, settings: Settings, upstream: Upstream, emit, transport: str,
                 trace_id: str | None = None):
        self.sid, self.claims, self.s, self.up, self.emit, self.transport = sid, claims, settings, upstream, emit, transport
        self.trace_id = trace_id or new_trace_id()
        self.cfg: dict = dict(claims.get("cfg") or {})
        self.messages: list[dict] = list(self.cfg.get("messages") or [])
        self.lang = (self.cfg.get("language") or "pt")[:2]
        self.server_vad = self.cfg.get("vad", "server") != "client"
        self.vad = EnergyVad(settings.vad_silence_ms, load_silero())
        self.out = AudioOut()
        self.started = time.monotonic()
        self.last_input = time.monotonic()
        self.turn_buf = bytearray()
        self.turn_start: int | None = None  # byte offset in turn_buf where speech began (server VAD)
        self.last_speech_at: float | None = None
        speculate_frames = settings.speculate_ms // 20
        self.speculate_frames = speculate_frames if speculate_frames < self.vad.silence_frames else 0
        self.confirmed: asyncio.Future | None = None
        self.pending = np.zeros(0, dtype=np.float32)
        self.turn_task: asyncio.Task | None = None
        self.partials = None
        self.partials_task: asyncio.Task | None = None
        self.partials_failed = False
        self.closed = False
        self.turns = 0
        self.turn_id: str | None = None
        self.outcome = "ok"
        self.last_opener = -1
        self._warm_openers()

    def tel(self, event: str, **kw) -> None:
        telemetry.emit(event, trace_id=self.trace_id, session_id=self.sid, **kw)

    def deadline_ms(self) -> int:
        asked = self.cfg.get("first_audio_deadline_ms")
        asked = asked if isinstance(asked, int) and asked > 0 else self.s.first_audio_deadline_ms
        return min(asked, MAX_FIRST_AUDIO_DEADLINE_MS)

    def _warm_openers(self) -> None:
        cfg = dict(self.cfg)

        async def synth(line: str) -> bytes:
            fields = await self.up.voice_fields(cfg)
            rate, pcm = self.s.tts_rate, bytearray()
            async for chunk in self.up.speak(line, cfg, fields, self.trace_id):
                if isinstance(chunk, int):
                    rate = chunk
                else:
                    pcm += chunk
            return opener.trim_lead(resample_pcm16(bytes(pcm), rate, OUT_RATE), OUT_RATE)

        opener.warm(cfg, synth)

    # ── input ────────────────────────────────────────────────────────────────

    def feed(self, pcm16: bytes) -> None:
        """PCM16 LE mono 16 kHz from the transport, any length."""
        if self.closed or not pcm16:
            return
        self.last_input = time.monotonic()
        self.turn_buf += pcm16
        self._partials_push(pcm16)
        samples = np.frombuffer(pcm16[: len(pcm16) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768.0
        self.pending = np.concatenate([self.pending, samples])
        while len(self.pending) >= FRAME_SAMPLES:
            frame, self.pending = self.pending[:FRAME_SAMPLES], self.pending[FRAME_SAMPLES:]
            change = self.vad.push(frame)
            if self.vad.speaking and not self.vad.quiet_run:
                self.last_speech_at = time.monotonic()
                self._discard_speculation()
            elif self.vad.speaking and self.vad.quiet_run == self.speculate_frames:
                self._speculate()
            self._on_vad(change)
        max_bytes = self.s.max_turn_seconds * 16000 * 2
        if self.turn_start is not None and len(self.turn_buf) - self.turn_start >= max_bytes:
            self.end_turn(reason="max_turn")
        elif self.turn_start is None and len(self.turn_buf) > max_bytes:
            # Nobody spoke (server VAD) or the client has not said end_turn yet: keep a rolling window only.
            keep = PRE_ROLL_FRAMES * FRAME_SAMPLES * 2 if self.server_vad else max_bytes
            del self.turn_buf[: len(self.turn_buf) - keep]

    def _on_vad(self, change: str | None) -> None:
        if not change:
            return
        if change == "start":
            self.emit({"type": "vad", "state": "start"})
            if self.server_vad:
                if self.busy:
                    self.interrupt()
                pre = PRE_ROLL_FRAMES * FRAME_SAMPLES * 2
                self.turn_start = max(0, len(self.turn_buf) - pre - FRAME_SAMPLES * 2 * 3)
                self._partials_open()
        else:
            self.emit({"type": "vad", "state": "end"})
            if self.server_vad and self.turn_start is not None:
                self.end_turn(reason="vad")

    @property
    def busy(self) -> bool:
        return self.turn_task is not None and not self.turn_task.done()

    def control(self, msg: dict) -> None:
        kind = msg.get("type")
        self.last_input = time.monotonic()
        if kind == "interrupt":
            self.interrupt()
        elif kind == "end_turn":
            self.end_turn(reason="client")
        elif kind == "config_update":
            self._discard_speculation()
            if isinstance(msg.get("messages"), list):
                # Appended to the history (docs/realtime.md): the SDK replays a broken session's turns into the new one.
                self.messages += [m for m in msg["messages"] if isinstance(m, dict) and "role" in m and "content" in m]
            for key in ("system", "voice", "fallback_voice", "max_tokens", "temperature", "stt_prompt", "user_template",
                        "opener", "first_audio_deadline_ms"):
                if key in msg:
                    self.cfg[key] = msg[key]
            self._warm_openers()
        elif kind == "ping":
            self.emit({"type": "pong", "t": msg.get("t")})
        else:
            self.emit({"type": "error", "code": "bad_message", "message": f"unknown type {kind!r}"})

    def interrupt(self) -> None:
        if self.busy and self.confirmed is None:
            self.turn_task.cancel()
            self.out.clear()
            self.emit({"type": "interrupted"})
            self.emit({"type": "done", "interrupted": True, "turnId": self.turn_id})

    def end_turn(self, reason: str) -> None:
        start = self.turn_start if self.turn_start is not None else 0
        audio = bytes(self.turn_buf[start:])
        self.turn_buf.clear()
        self.turn_start = None
        self._partials_close()
        if self.confirmed is not None:
            self.confirmed.set_result(time.monotonic())
            self.confirmed = None
            return
        if self.busy:
            if reason == "client":
                self.interrupt()  # a new client turn supersedes the old one
            else:
                return
        if len(audio) < MIN_TURN_BYTES:
            if reason == "client":
                self.emit({"type": "done", "empty": True})
            return
        self._start_turn(audio)

    def _start_turn(self, audio: bytes, confirmed: asyncio.Future | None = None) -> None:
        self.turns += 1
        self.turn_id = f"{self.sid}:{self.turns}"
        self.turn_task = asyncio.create_task(self._turn(audio, time.monotonic(), self.turn_id, self.last_speech_at, confirmed))

    def _speculate(self) -> None:
        if not self.server_vad or self.turn_start is None or self.busy or self.s.upstream_mode == "s2s":
            return
        self.confirmed = asyncio.get_running_loop().create_future()
        self._start_turn(bytes(self.turn_buf[self.turn_start:]), self.confirmed)

    def _discard_speculation(self) -> None:
        if self.confirmed is None:
            return
        self.confirmed = None
        self.turn_task.cancel()
        self.turn_task = None
        self.turns -= 1

    # ── partial transcripts (the replica's /ws/audio-stream, best effort) ─────

    def _partials_open(self) -> None:
        if not self.s.stt_partials or self.partials_failed or self.partials_task:
            return

        async def run():
            try:
                self.partials = await self.up.open_partials(self.lang, self.trace_id)
                async for msg in self.partials:
                    if msg.type != 1:  # TEXT
                        break
                    data = msg.json()
                    if data.get("text") and not data.get("final"):
                        self.emit({"type": "transcript", "text": data["text"], "final": False})
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001 — a replica without the route: no partials for this session
                self.partials_failed = True
            finally:
                ws, self.partials = self.partials, None
                if ws is not None:
                    await ws.close()

        self.partials_task = asyncio.create_task(run())

    def _partials_push(self, pcm16: bytes) -> None:
        ws = self.partials
        if ws is not None and not ws.closed:
            async def send():
                try:
                    await ws.send_bytes(pcm16)
                except Exception:  # noqa: BLE001 — the partials socket is best effort
                    pass
            asyncio.ensure_future(send())

    def _partials_close(self) -> None:
        if self.partials_task:
            self.partials_task.cancel()
            self.partials_task = None

    # ── one turn ─────────────────────────────────────────────────────────────

    async def _turn(self, audio: bytes, ended: float, turn_id: str, last_speech_at: float | None = None,
                    confirmed: asyncio.Future | None = None) -> None:
        ms = lambda since: round((time.monotonic() - since) * 1000)  # noqa: E731
        metrics: dict = {"ttfa_ms": None, "stt_ms": None, "llm_ttft_ms": None, "tts_ttfb_ms": None,
                         "endpoint_ms": ms_between(last_speech_at, ended), "first_sound_ms": None, "opener": None,
                         "deadline_ms": self.deadline_ms(), "deadline_missed": False, "tts_retries": 0}
        user_text, spoken = None, []
        thinking = deltas = None
        self.outcome = "ok"
        tel = lambda event, **kw: self.tel(event, turn_id=turn_id, **kw)  # noqa: E731
        watch = asyncio.create_task(self._deadline(ended, last_speech_at, confirmed, metrics, turn_id, tel))
        try:
            if self.s.upstream_mode == "s2s":
                user_text = await self._turn_s2s(audio, ended, metrics, spoken, tel)
                return
            t = time.monotonic()
            heard = await asyncio.wait_for(self._transcribe(audio, confirmed), 60)
            metrics["stt_ms"] = ms(t)
            text = (heard.get("text") or "").strip()
            if confirmed is not None:
                kept, codes = self._verdict(text, heard)
                if kept and not codes:
                    thinking, deltas = self._llm_ahead(text, metrics, tel)
                ended = await asyncio.shield(confirmed)
                metrics["endpoint_ms"] = ms_between(last_speech_at, ended)
            passed = self._guard(text, heard)
            tel("edge.stt.done", dur_ms=metrics["stt_ms"], filtered=self.outcome == "filtered", audioMs=len(audio) // 32,
                chars=len(text))
            if not passed:
                return
            user_text = text
            await self._answer(text, ended, metrics, spoken, tel, deltas)
        except asyncio.CancelledError:
            self.outcome = "interrupted" if confirmed is None or confirmed.done() else "discarded"
            raise
        except Exception as error:  # noqa: BLE001 — the turn fails, the session stays
            self.outcome = "error"
            stage = error.stage if isinstance(error, UpstreamError) else ("timeout" if isinstance(error, asyncio.TimeoutError) else "edge")
            tel("edge.upstream.error", level="error", stage=stage, status=getattr(error, "status", None),
                error=type(error).__name__, requestId=getattr(error, "request_id", None))
            self.emit({"type": "error", "code": "upstream", "message": repr(error)[:300]})
            self.emit({"type": "done", "error": True, "turnId": turn_id})
        finally:
            if metrics["opener"] is None or self.outcome in ("interrupted", "discarded"):
                watch.cancel()
            late = metrics["opener"] is not None or metrics["deadline_missed"]
            first_audio = ttfa_from_speech(metrics) or metrics["ttfa_ms"] or (metrics["deadline_ms"] + 1 if late else None)
            if first_audio is not None and self.outcome in ("ok", "error"):
                recent_first_audio.append((time.monotonic(), first_audio))
            tel("edge.turn.done", dur_ms=ms(ended), outcome=self.outcome, ttfaMs=metrics["ttfa_ms"],
                sttMs=metrics["stt_ms"], llmTtftMs=metrics["llm_ttft_ms"], ttsTtfbMs=metrics["tts_ttfb_ms"],
                sentences=len(spoken), replyChars=sum(len(x) for x in spoken), endpointMs=metrics["endpoint_ms"],
                ttfaFromSpeechMs=ttfa_from_speech(metrics), speculated=confirmed is not None,
                firstSoundMs=metrics["first_sound_ms"], firstSoundFromSpeechMs=ttfa_from_speech(metrics, "first_sound_ms"),
                opener=metrics["opener"], deadlineMs=metrics["deadline_ms"], deadlineMissed=metrics["deadline_missed"],
                ttsRetries=metrics["tts_retries"])
            if thinking is not None:
                thinking.cancel()
            if user_text:
                template = self.cfg.get("user_template") or ""
                user = template.replace("{{transcript}}", user_text) if "{{transcript}}" in template else user_text
                self.messages.append({"role": "user", "content": user})
                if spoken:
                    self.messages.append({"role": "assistant", "content": " ".join(spoken)})

    async def _deadline(self, ended: float, last_speech_at: float | None, confirmed: asyncio.Future | None,
                        metrics: dict, turn_id: str, tel) -> None:
        if confirmed is not None:
            ended = await asyncio.shield(confirmed)
        spoke = last_speech_at or ended
        due = lambda ms: asyncio.sleep(max(0.0, spoke + ms / 1000 - time.monotonic()))  # noqa: E731
        await due(metrics["deadline_ms"] - self.s.first_audio_margin_ms)
        if metrics["first_sound_ms"] is not None:
            return
        picked = opener.pick(self.cfg, self.last_opener + 1)
        if picked is None:
            await due(metrics["deadline_ms"])
            if metrics["first_sound_ms"] is None:
                metrics["deadline_missed"] = True
                tel("edge.turn.deadline_missed", level="warn", deadlineMs=metrics["deadline_ms"],
                    opener=bool(opener.lines_of(self.cfg)))
                self.emit({"type": "deadline_missed", "deadline_ms": metrics["deadline_ms"], "turnId": turn_id})
            return
        self.last_opener, line, pcm = picked
        metrics["opener"] = line
        metrics["first_sound_ms"] = round((time.monotonic() - ended) * 1000)
        tel("edge.turn.opener", index=self.last_opener, chars=len(line), dur_ms=round((time.monotonic() - spoke) * 1000))
        self.emit({"type": "opener", "state": "start", "text": line, "index": self.last_opener,
                   "audio_ms": len(pcm) // OUT_BYTES_PER_MS, "turnId": turn_id})
        self.out.push(pcm)
        self.emit({"type": "opener", "state": "end", "index": self.last_opener, "turnId": turn_id})
        await self.out.drained.wait()
        if metrics["ttfa_ms"] is None:
            self.emit({"type": "audio_end"})

    def _first_reply_audio(self, ended: float, metrics: dict) -> None:
        metrics["ttfa_ms"] = round((time.monotonic() - ended) * 1000) + len(self.out.buf) // OUT_BYTES_PER_MS
        if metrics["first_sound_ms"] is None:
            metrics["first_sound_ms"] = metrics["ttfa_ms"]
        self.emit({"type": "audio_start"})

    def _metrics_event(self, metrics: dict) -> dict:
        return {"type": "metrics", **metrics, "ttfa_from_speech_ms": ttfa_from_speech(metrics),
                "first_sound_from_speech_ms": ttfa_from_speech(metrics, "first_sound_ms"), "turnId": self.turn_id}

    async def _transcribe(self, audio: bytes, confirmed: asyncio.Future | None) -> dict:
        try:
            return await self.up.transcribe(audio, self.lang, self.cfg.get("stt_prompt"), self.trace_id)
        except Exception:
            if confirmed is not None:
                await asyncio.shield(confirmed)
            raise

    def _llm_ahead(self, text: str, metrics: dict, tel) -> tuple:
        read: asyncio.Queue = asyncio.Queue()

        async def think() -> None:
            t = time.monotonic()
            try:
                async for delta in self.up.chat_stream(self._messages_for(text), self.cfg, self.trace_id):
                    if metrics["llm_ttft_ms"] is None:
                        metrics["llm_ttft_ms"] = ms_between(t, time.monotonic())
                        tel("edge.llm.first_token", dur_ms=metrics["llm_ttft_ms"])
                    read.put_nowait(delta)
                read.put_nowait(None)
            except Exception as error:  # noqa: BLE001
                read.put_nowait(error)

        async def deltas():
            while (delta := await read.get()) is not None:
                if isinstance(delta, Exception):
                    raise delta
                yield delta

        return asyncio.create_task(think()), deltas()

    def _verdict(self, text: str, heard: dict) -> tuple[str, list[str]]:
        return (text, []) if self.cfg.get("filter_hallucinations") is False else filter_transcript(text, self.lang, heard)

    def _guard(self, text: str, heard: dict) -> bool:
        """transcript / filtered / done{empty} — False when the turn stops here."""
        kept, codes = self._verdict(text, heard)
        if codes:
            self.outcome = "filtered"
            self.tel("edge.stt.filtered", turn_id=self.turn_id, codes=",".join(codes), chars=len(text))
            self.emit({"type": "filtered", "reasons": codes})
            self.emit({"type": "done", "filtered": True, "turnId": self.turn_id})
            return False
        self.emit({"type": "transcript", "text": kept, "final": True, "turnId": self.turn_id})
        if not kept:
            self.outcome = "empty"
            self.emit({"type": "done", "empty": True, "turnId": self.turn_id})
            return False
        return True

    def _messages_for(self, text: str) -> list[dict]:
        template = self.cfg.get("user_template") or ""
        user = template.replace("{{transcript}}", text) if "{{transcript}}" in template else text
        system = [{"role": "system", "content": self.cfg["system"]}] if self.cfg.get("system") else []
        return system + self.messages + [{"role": "user", "content": user}]

    async def _answer(self, text: str, ended: float, metrics: dict, spoken: list[str], tel, deltas=None) -> None:
        ms = lambda since: round((time.monotonic() - since) * 1000)  # noqa: E731
        fields = await self.up.voice_fields(self.cfg)
        gate = asyncio.Semaphore(self.s.tts_parallel)
        sentences: asyncio.Queue = asyncio.Queue()
        field = JsonField(self.cfg["speak_field"]) if self.cfg.get("speak_field") else None
        raw: list[str] = []
        synths: list[asyncio.Task] = []

        def retried(error: UpstreamError) -> None:
            metrics["tts_retries"] += 1
            tel("edge.tts.retry", level="warn", requestId=error.request_id, reason=str(error)[:160])

        async def synth(sentence: str, queue: asyncio.Queue) -> None:
            try:
                async with gate:
                    t = time.monotonic()
                    rate = self.s.tts_rate
                    async for chunk in self.up.speak(sentence, self.cfg, fields, self.trace_id, retried):
                        if isinstance(chunk, int):
                            rate = chunk
                            continue
                        if metrics["tts_ttfb_ms"] is None:
                            metrics["tts_ttfb_ms"] = ms(t)
                            tel("edge.tts.first_audio", dur_ms=metrics["tts_ttfb_ms"], chars=len(sentence))
                        await queue.put(resample_pcm16(chunk, rate, OUT_RATE))
            except Exception as error:  # noqa: BLE001 — surfaced by the speaker
                await queue.put(error)
            finally:
                await queue.put(None)

        def speak(sentence: str) -> None:
            spoken.append(sentence)
            queue: asyncio.Queue = asyncio.Queue()
            synths.append(asyncio.create_task(synth(sentence, queue)))
            sentences.put_nowait(queue)

        async def think() -> None:
            t = time.monotonic()
            buffer, first, closed = "", True, False
            async for delta in deltas or self.up.chat_stream(self._messages_for(text), self.cfg, self.trace_id):
                if metrics["llm_ttft_ms"] is None:
                    metrics["llm_ttft_ms"] = ms(t)
                    tel("edge.llm.first_token", dur_ms=metrics["llm_ttft_ms"])
                raw.append(delta)
                if field is not None:
                    if closed:
                        continue
                    delta, closed = field.push(delta)
                if delta:
                    self.emit({"type": "reply_delta", "text": delta})
                buffer += delta
                while True:
                    chunk, buffer = cut(buffer, first, False)
                    if not chunk:
                        break
                    first = False
                    speak(chunk)
            chunk, _ = cut(buffer, first, True)
            if chunk:
                speak(chunk)
            reply = {"type": "reply", "text": " ".join(spoken)}
            if field is not None:
                reply["raw"] = "".join(raw)
            self.emit(reply)
            sentences.put_nowait(None)

        thinker = asyncio.create_task(think())
        try:
            while True:
                queue = await sentences.get()
                if queue is None:
                    break
                while (chunk := await queue.get()) is not None:
                    if isinstance(chunk, Exception):
                        raise chunk
                    if metrics["ttfa_ms"] is None:
                        self._first_reply_audio(ended, metrics)
                    self.out.push(chunk)
                    await asyncio.sleep(0)
            await thinker
            if metrics["ttfa_ms"] is not None:
                await self.out.drained.wait()
                self.emit({"type": "audio_end"})
            self.emit(self._metrics_event(metrics))
            self.emit({"type": "done", "turnId": self.turn_id})
        finally:
            thinker.cancel()
            for task in synths:
                task.cancel()

    async def _turn_s2s(self, audio: bytes, ended: float, metrics: dict, spoken: list[str], tel) -> str | None:
        """EDGE_UPSTREAM_MODE=s2s: the replica's own /v1/s2s answers the turn; the edge re-emits it in the realtime
        events and still applies the hallucination guard on the transcript (abandoning the call when it trips)."""
        cfg = {**self.cfg, "messages": self.messages, "opener": None}
        heard_text = None
        async for kind, item in self.up.s2s(audio, cfg, self.trace_id):
            if kind == "A":
                if metrics["ttfa_ms"] is None:
                    self._first_reply_audio(ended, metrics)
                self.out.push(item)
                continue
            kind_e = item.get("type")
            if kind_e == "transcript":
                metrics["stt_ms"] = item.get("stt_ms")
                heard_text = (item.get("text") or "").strip()
                passed = self._guard(heard_text, item)
                tel("edge.stt.done", dur_ms=metrics["stt_ms"], filtered=self.outcome == "filtered", audioMs=len(audio) // 32,
                    chars=len(heard_text))
                if not passed:
                    return None
            elif kind_e == "llm_first_token":
                metrics["llm_ttft_ms"] = item.get("at_ms")
                tel("edge.llm.first_token", dur_ms=item.get("at_ms"))
            elif kind_e == "sentence":
                spoken.append(item.get("text", ""))
                self.emit({"type": "reply_delta", "text": item.get("text", "")})
            elif kind_e == "error":
                raise RuntimeError(item.get("message", "s2s error"))
            elif kind_e == "done":
                metrics["tts_retries"] = item.get("tts_retries", 0)
                self.emit({"type": "reply", "text": item.get("reply", " ".join(spoken))})
        if metrics["ttfa_ms"] is not None:
            await self.out.drained.wait()
            self.emit({"type": "audio_end"})
        self.emit(self._metrics_event(metrics))
        self.emit({"type": "done", "turnId": self.turn_id})
        return heard_text

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self._partials_close()
        if self.busy:
            self.turn_task.cancel()
        self.out.clear()
