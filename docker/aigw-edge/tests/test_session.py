import asyncio
import collections
import os
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["EDGE_TELEMETRY_STDOUT"] = "0"

from aigw_edge import session as session_module  # noqa: E402
from aigw_edge.config import Settings  # noqa: E402
from fake_upstream import HEARD, LLM_TOKEN_MS, LLM_TTFT_MS, REPLY, STT_MS, TTS_TTFB_MS  # noqa: E402

FRAME_S = 0.02
TONE = (0.25 * np.sin(np.arange(320) / 16000 * 2 * np.pi * 200) * 32767).astype(np.int16).tobytes()
SILENCE = bytes(640)
CFG = {"system": "Você é o padeiro.", "voice": "v", "language": "pt"}
failures = 0
telemetry_events: list[tuple[str, dict]] = []
session_module.telemetry.emit = lambda event, **kw: telemetry_events.append((event, kw))


def check(name, ok, detail=None):
    global failures
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail is not None else ""), flush=True)
    failures += 0 if ok else 1


class FakePartials:
    def __init__(self):
        self.closed = False
        self.messages: asyncio.Queue = asyncio.Queue()
        self.samples = self.sent = 0

    async def send_bytes(self, pcm16: bytes) -> None:
        self.samples += len(pcm16) // 2
        if self.samples // 4000 > self.sent:
            self.sent = self.samples // 4000
            self.messages.put_nowait(f"parcial {self.sent}")

    def __aiter__(self):
        return self

    async def __anext__(self):
        text = await self.messages.get()
        return type("Message", (), {"type": 1, "json": lambda self: {"text": text}})()

    async def close(self) -> None:
        self.closed = True


class FakeUpstream:
    def __init__(self):
        self.calls: collections.Counter = collections.Counter()
        self.cancelled: collections.Counter = collections.Counter()
        self.llm_messages: list[dict] = []

    async def transcribe(self, pcm16, language, prompt, trace_id=None):
        self.calls["stt"] += 1
        try:
            await asyncio.sleep(STT_MS / 1000)
        except asyncio.CancelledError:
            self.cancelled["stt"] += 1
            raise
        return {"text": HEARD, "no_speech_prob": 0.01, "avg_logprob": -0.2, "compression_ratio": 1.2}

    async def chat_stream(self, messages, cfg, trace_id=None):
        self.calls["llm"] += 1
        self.llm_messages = messages
        finished = False
        try:
            await asyncio.sleep(LLM_TTFT_MS / 1000)
            for i, word in enumerate(REPLY.split(" ")):
                if i:
                    await asyncio.sleep(LLM_TOKEN_MS / 1000)
                yield (" " if i else "") + word
            finished = True
        finally:
            self.cancelled["llm"] += 0 if finished else 1

    async def voice_fields(self, cfg):
        return {"voice": cfg["voice"]}

    async def speak(self, text, cfg, fields, trace_id=None):
        self.calls["tts"] += 1
        await asyncio.sleep(TTS_TTFB_MS / 1000)
        yield bytes(960 * 10)

    async def open_partials(self, language, trace_id=None):
        self.calls["partials"] += 1
        return FakePartials()


class Learner:
    def __init__(self, cfg: dict | None = None, **settings):
        self.up = FakeUpstream()
        self.events: list[tuple[float, dict]] = []
        self.session = session_module.Session("s", {"cfg": cfg or CFG}, Settings(**settings), self.up,
                                              lambda e: self.events.append((time.monotonic(), e)), "ws")
        self.frames: collections.deque = collections.deque()
        self.speech_end_at: float | None = None
        self.heard_frames = 0
        self.mic = asyncio.create_task(self._mic())

    def say(self, seconds: float) -> None:
        self.frames.extend([TONE] * round(seconds / FRAME_S))

    async def _mic(self) -> None:
        start, sent = time.monotonic(), 0
        while True:
            speaking = bool(self.frames)
            self.session.feed(self.frames.popleft() if speaking else SILENCE)
            self.heard_frames += self.session.out.pull() is not None
            if speaking and not self.frames:
                self.speech_end_at = time.monotonic()
            sent += 1
            await asyncio.sleep(max(0, start + sent * FRAME_S - time.monotonic()))

    def of(self, kind: str, after: int = 0) -> list[dict]:
        return [e for _, e in self.events[after:] if e["type"] == kind]

    def at(self, kind: str, **match) -> float:
        return next(t for t, e in self.events if e["type"] == kind and all(e.get(k) == v for k, v in match.items()))

    async def wait(self, kind: str, timeout: float = 5.0, after: int = 0) -> dict:
        deadline = time.monotonic() + timeout
        while not self.of(kind, after):
            if time.monotonic() > deadline:
                raise TimeoutError(f"no {kind!r}; got {[e['type'] for _, e in self.events]}")
            await asyncio.sleep(0.005)
        return self.of(kind, after)[0]

    async def close(self) -> None:
        self.mic.cancel()
        await self.session.close()
        await asyncio.sleep(0.05)


def turn_done(after: int = 0) -> dict:
    return [kw for event, kw in telemetry_events[after:] if event == "edge.turn.done"][-1]


async def endpoint_metrics() -> None:
    learner = Learner()
    learner.say(0.5)
    metrics = await learner.wait("metrics")
    waited = round((learner.at("vad", state="end") - learner.speech_end_at) * 1000)
    ttfa = round((learner.at("audio_start") - learner.at("vad", state="end")) * 1000)
    check("metrics: endpoint_ms is the silence waited after the last speech frame",
          abs(metrics["endpoint_ms"] - waited) <= 25 and 660 <= metrics["endpoint_ms"] <= 800, (metrics, waited))
    check("metrics: ttfa_ms still starts at the end of the turn", abs(metrics["ttfa_ms"] - ttfa) <= 15, (metrics, ttfa))
    check("metrics: ttfa_from_speech_ms = endpoint_ms + ttfa_ms",
          metrics["ttfa_from_speech_ms"] == metrics["endpoint_ms"] + metrics["ttfa_ms"], metrics)
    done = turn_done()
    check("telemetry: edge.turn.done carries endpointMs and ttfaFromSpeechMs",
          (done["endpointMs"], done["ttfaFromSpeechMs"]) == (metrics["endpoint_ms"], metrics["ttfa_from_speech_ms"]), done)
    await learner.close()

    learner = Learner({**CFG, "vad": "client"})
    learner.say(0.5)
    await asyncio.sleep(0.7)
    learner.session.control({"type": "end_turn"})
    metrics = await learner.wait("metrics")
    check("metrics: a client end_turn 200 ms after the speech reports that wait", 150 <= metrics["endpoint_ms"] <= 280, metrics)
    await learner.close()

    learner = Learner({**CFG, "vad": "client"})
    await asyncio.sleep(0.5)
    learner.session.control({"type": "end_turn"})
    metrics = await learner.wait("metrics")
    check("metrics: no speech heard by the VAD → endpoint_ms and ttfa_from_speech_ms are null",
          metrics["endpoint_ms"] is None and metrics["ttfa_from_speech_ms"] is None and metrics["ttfa_ms"] is not None, metrics)
    await learner.close()


async def main() -> None:
    for scenario in (endpoint_metrics,):
        await scenario()


asyncio.run(main())
sys.exit(1 if failures else 0)
