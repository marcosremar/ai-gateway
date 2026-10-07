import asyncio
import collections
import json
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
results: dict = {}
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
        self.stt_fails = False

    async def transcribe(self, pcm16, language, prompt, trace_id=None):
        self.calls["stt"] += 1
        try:
            await asyncio.sleep(STT_MS / 1000)
        except asyncio.CancelledError:
            self.cancelled["stt"] += 1
            raise
        if self.stt_fails:
            raise RuntimeError("stt down")
        return {"text": prompt[5:] if (prompt or "").startswith("FAKE:") else HEARD, "no_speech_prob": 0.01, "avg_logprob": -0.2, "compression_ratio": 1.2}

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
            if not finished:
                self.cancelled["llm"] += 1

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

    async def spoken(self, then: float = 0.0) -> None:
        while self.frames:
            await asyncio.sleep(0.005)
        await asyncio.sleep(then)

    def types(self) -> list[str]:
        return [e["type"] for _, e in self.events]

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


async def first_audio_after_speech(speculate_ms: int) -> tuple[int, Learner]:
    learner = Learner(speculate_ms=speculate_ms, stt_partials=False)
    learner.say(0.5)
    await learner.wait("done")
    await learner.close()
    return round((learner.at("audio_start") - learner.speech_end_at) * 1000), learner


async def speculation_confirmed() -> None:
    plain_ms, plain = await first_audio_after_speech(0)
    early_ms, early = await first_audio_after_speech(300)
    check("speculation off: one STT, one LLM, ttfa_ms = STT + LLM + TTS", plain.up.calls == {"stt": 1, "llm": 1, "tts": 3}
          and plain.of("metrics")[0]["ttfa_ms"] >= STT_MS + LLM_TTFT_MS + TTS_TTFB_MS, plain.of("metrics"))
    check("speculation confirmed: its STT and LLM are reused, no second call", early.up.calls == {"stt": 1, "llm": 1, "tts": 3}
          and not early.up.cancelled, (early.up.calls, early.up.cancelled))
    check("speculation confirmed: first audio leaves earlier by the STT and LLM first-token delays",
          plain_ms - early_ms >= STT_MS + LLM_TTFT_MS - 30, {"off_ms": plain_ms, "on_ms": early_ms})
    ended = early.at("vad", state="end")
    held = [e["type"] for t, e in early.events if t < ended]
    check("speculation confirmed: nothing but vad events before the VAD's end", held == ["vad"], held)
    check("speculation confirmed: the same events as a plain turn", sorted(early.types()) == sorted(plain.types()), early.types())
    metrics = early.of("metrics")[0]
    check("speculation confirmed: stt_ms and llm_ttft_ms stay the upstream's own times, endpoint_ms the whole silence",
          metrics["stt_ms"] >= STT_MS and metrics["llm_ttft_ms"] >= LLM_TTFT_MS and metrics["endpoint_ms"] >= 660, metrics)
    check("speculation confirmed: history has the turn once", [m["role"] for m in early.session.messages] == ["user", "assistant"])
    results["first_audio_after_speech_ms"] = {"speculation_off": plain_ms, "speculation_300": early_ms}


async def speech_resumes(pause: float, cancelled: dict, name: str) -> None:
    mark = len(telemetry_events)
    learner = Learner(stt_partials=False)
    learner.say(0.5)
    await learner.spoken(pause)
    speculating = learner.session.confirmed is not None and learner.session.busy
    learner.say(0.4)
    await asyncio.sleep(0.06)
    check(f"{name}: the speculation is cancelled upstream and the session is free at once",
          speculating and learner.up.cancelled == cancelled and not learner.session.busy and learner.session.turns == 0
          and learner.session.confirmed is None, (speculating, learner.up.cancelled))
    check(f"{name}: nothing was emitted or queued as audio", learner.types() == ["vad"] and not learner.session.out.buf
          and learner.session.messages == [], learner.types())
    await learner.wait("done")
    check(f"{name}: one turn answered, as turn 1", learner.types().count("done") == 1 and learner.of("done")[0]["turnId"] == "s:1"
          and len([e for e in learner.of("transcript") if e["final"]]) == 1 and len(learner.of("reply")) == 1
          and "interrupted" not in learner.types() and "error" not in learner.types(), learner.types())
    check(f"{name}: history has the turn once", [m["role"] for m in learner.session.messages] == ["user", "assistant"]
          and [m["role"] for m in learner.up.llm_messages] == ["system", "user"], learner.session.messages)
    outcomes = [kw["outcome"] for event, kw in telemetry_events[mark:] if event == "edge.turn.done"]
    check(f"{name}: telemetry tells the discarded speculation from the turn", outcomes == ["discarded", "ok"], outcomes)
    await learner.close()


async def speculation_discarded() -> None:
    await speech_resumes(0.34, {"stt": 1}, "speech resumes during the speculative STT")
    await speech_resumes(0.46, {"llm": 1}, "speech resumes during the speculative LLM")


async def barge_in() -> None:
    learner = Learner(stt_partials=False)
    learner.say(0.5)
    await learner.spoken(0.45)
    learner.session.control({"type": "interrupt"})
    await learner.wait("done")
    check("interrupt during a speculation: no interrupted, the turn is answered once", "interrupted" not in learner.types()
          and learner.up.calls["llm"] == 1 and learner.heard_frames > 0, learner.types())
    await learner.close()

    learner = Learner(stt_partials=False)
    learner.say(0.5)
    await learner.wait("audio_start")
    await asyncio.sleep(0.1)
    learner.say(0.5)
    await learner.wait("interrupted")
    after = len(learner.events)
    await learner.wait("done", after=after)
    ended = [t for t, e in learner.events if e == {"type": "vad", "state": "end"}][-1]
    late = [e["type"] for t, e in learner.events[after:] if t < ended]
    check("barge-in then a speculation: one interrupted, the new turn held until the VAD's end, then answered",
          learner.types().count("interrupted") == 1 and late == [] and learner.of("done")[-1]["turnId"] == "s:2"
          and learner.of("metrics")[-1]["ttfa_ms"] < STT_MS + LLM_TTFT_MS + TTS_TTFB_MS, (late, learner.of("metrics")))
    check("barge-in then a speculation: history keeps both turns", [m["role"] for m in learner.session.messages]
          == ["user", "assistant", "user", "assistant"], learner.session.messages)
    await learner.close()


async def speculation_edges() -> None:
    learner = Learner(stt_partials=False)
    learner.up.stt_fails = True
    learner.say(0.5)
    await learner.spoken(0.45)
    check("speculative STT fails: nothing is said before the VAD's end", learner.types() == ["vad"], learner.types())
    error = await learner.wait("error")
    check("speculative STT fails: the confirmed turn reports the error", error["code"] == "upstream"
          and learner.at("error") >= learner.at("vad", state="end") and learner.of("done")[0].get("error") is True, learner.types())
    await learner.close()

    learner = Learner(stt_partials=False)
    learner.up.stt_fails = True
    learner.say(0.5)
    await learner.spoken(0.45)
    learner.up.stt_fails = False
    learner.say(0.4)
    await learner.wait("done")
    check("speculative STT fails, speech resumes: the failure is never shown", "error" not in learner.types()
          and len(learner.of("reply")) == 1, learner.types())
    await learner.close()

    learner = Learner({**CFG, "stt_prompt": "FAKE:Legendas pela comunidade Amara.org"}, stt_partials=False)
    learner.say(0.5)
    done = await learner.wait("done")
    check("speculation: a filtered transcript never reaches the LLM", done.get("filtered") is True and not learner.up.calls["llm"]
          and learner.session.messages == [], learner.up.calls)
    await learner.close()

    learner = Learner(stt_partials=False)
    learner.say(0.5)
    await learner.spoken(0.45)
    learner.session.control({"type": "config_update", "messages": [{"role": "assistant", "content": "Oi."}]})
    await learner.wait("done")
    check("config_update during a speculation: the turn is answered with the new history", learner.up.cancelled == {"llm": 1}
          and [m["role"] for m in learner.up.llm_messages] == ["system", "assistant", "user"], learner.up.llm_messages)
    await learner.close()

    learner = Learner({**CFG, "vad": "client"}, stt_partials=False)
    learner.say(0.5)
    await learner.spoken(0.5)
    check("client VAD: no speculation", not learner.up.calls and learner.session.confirmed is None, learner.up.calls)
    await learner.close()

    learner = Learner(stt_partials=False, upstream_mode="s2s")
    learner.say(0.5)
    await learner.spoken(0.5)
    check("s2s mode: no speculation", learner.session.confirmed is None and not learner.session.busy)
    await learner.close()

    tasks = len(asyncio.all_tasks())
    learner = Learner(stt_partials=False)
    learner.say(0.5)
    await learner.spoken(0.45)
    speculating = learner.session.busy
    await learner.close()
    check("close during a speculation: its upstream call is cancelled, no task left, nothing emitted",
          speculating and learner.up.cancelled == {"llm": 1} and len(asyncio.all_tasks()) == tasks
          and learner.types() == ["vad"] and learner.session.messages == [], (learner.up.cancelled, learner.types()))


async def main() -> None:
    for scenario in (endpoint_metrics, speculation_confirmed, speculation_discarded, barge_in, speculation_edges):
        await scenario()
    print(json.dumps(results))


asyncio.run(main())
sys.exit(1 if failures else 0)
