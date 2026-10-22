"""
One TTS engine loaded at a time on the speech-stack: Qwen3-TTS (vLLM-Omni, GPU), Kokoro-82M (ONNX, CPU) or Pocket TTS
(Kyutai, torch, in its own process). They can all be chosen, but only the chosen one holds memory: switching unloads
the active engine (stops vLLM-Omni and frees its VRAM; drops Kokoro; stops the Pocket process) before loading the next.
Whisper and the LLM are never touched.

Two ways to switch:
- `select(name)` — `POST /v1/tts/engine` (the gateway, when an app session starts with its TTS alias). Immediate when
  the active engine is idle (no sentence in flight and none for `switch_idle_s`), else refused with `in_use` unless
  `force`.
- `admit(name)` — every `/v1/audio/speech` / `/v1/s2s` request. The active engine answers at once; a request for
  another engine starts a switch only when the active one has been idle for `switch_idle_s`, and is itself answered
  with a quick 503 (`loading`, or `busy` when the active engine is in use) so the gateway speaks that line with its next
  link (the CPU voice server) instead of waiting.

Why "idle for switch_idle_s" (default 120 s) and not "switch on every request": a Qwen3-TTS start takes 1–2 minutes
(vLLM-Omni + warm-up) and each switch drops the other engine's warm state, so two apps with different engines on one
replica would thrash it into never serving at all. With the idle rule the engine in use keeps the GPU, the other
alias's lines go to their fallback (no wait), and the replica follows a change of engine as soon as the old one is
no longer used.

    manager = EngineManager({"qwen": QwenEngine(...), ...}, switch_idle_s=120)
    await manager.select("pocket")          # {"ok": True, ...} or {"ok": False, "code": "in_use", ...}
    verdict = manager.admit("kokoro")      # Admit(ok=False, code="loading", retry_after=...)
    with manager.use("kokoro"): ...        # counts the request in flight (a switch waits for it)
"""

from __future__ import annotations

import asyncio
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Protocol

ENGINES = ("qwen", "kokoro", "pocket")
DEFAULT_SWITCH_IDLE_S = 120.0
# A switch waits this long for the old engine's sentences in flight before unloading it anyway.
DRAIN_S = 30.0
# Retry-After of a 503 while the engine loads, per engine (seconds): Qwen3-TTS starts vLLM-Omni.
LOAD_RETRY_S = {"qwen": 60, "kokoro": 5, "pocket": 15}


def engine_of(model: str | None) -> str:
    """The engine a `/v1/audio/speech` model names: "kokoro…" → kokoro, "pocket…" → pocket, anything else Qwen3-TTS."""
    m = str(model or "").lower()
    if "kokoro" in m:
        return "kokoro"
    if "pocket" in m:
        return "pocket"
    return "qwen"


class Engine(Protocol):
    async def load(self) -> None: ...

    async def unload(self) -> None: ...


@dataclass
class Admit:
    ok: bool
    code: str = ""
    message: str = ""
    retry_after: int = 0


class EngineManager:
    def __init__(self, engines: dict[str, Engine], switch_idle_s: float = DEFAULT_SWITCH_IDLE_S,
                 clock: Callable[[], float] = time.monotonic, log: Callable[[str], None] = print):
        self.engines = engines
        self.switch_idle_s = switch_idle_s
        self.clock = clock
        self.log = log
        self.active: str | None = None
        self.target: str | None = None
        self.status: dict[str, dict] = {name: {"status": "unloaded", "since": clock()} for name in engines}
        self.inflight = {name: 0 for name in engines}
        self.last_used: dict[str, float] = {}
        self.switches = 0
        self.lock = asyncio.Lock()
        self.task: asyncio.Task | None = None

    # ── state ───────────────────────────────────────────────────────────────

    def set(self, name: str, status: str, detail: str | None = None) -> None:
        self.status[name] = {"status": status, "since": self.clock(), **({"detail": detail[:300]} if detail else {})}

    def loaded(self, name: str) -> bool:
        return self.active == name and self.status[name]["status"] == "loaded"

    def idle_for(self, name: str) -> float:
        if self.inflight.get(name):
            return 0.0
        return self.clock() - self.last_used.get(name, float("-inf"))

    def view(self) -> dict:
        now = self.clock()
        return {
            "active": self.active, "switching_to": self.target, "switch_idle_s": self.switch_idle_s, "switches": self.switches,
            "engines": {name: {**{k: v for k, v in s.items() if k != "since"}, "for_s": round(now - s["since"], 1),
                               "inflight": self.inflight[name]} for name, s in self.status.items()},
        }

    def mark_loaded(self, name: str) -> None:
        """`name` is the active engine and serves now (tests; an engine started outside the manager)."""
        self.active = name
        self.set(name, "loaded")
        self.last_used[name] = self.clock()

    def begin(self, name: str) -> None:
        self.inflight[name] += 1
        self.last_used[name] = self.clock()

    def end(self, name: str) -> None:
        self.inflight[name] = max(0, self.inflight[name] - 1)
        self.last_used[name] = self.clock()

    @contextmanager
    def use(self, name: str):
        """One request served by `name`: a switch waits for it before unloading the engine."""
        self.begin(name)
        try:
            yield
        finally:
            self.end(name)

    # ── switching ───────────────────────────────────────────────────────────

    def _start_switch(self, name: str) -> None:
        self.target = name
        self.task = asyncio.ensure_future(self._switch(name))

    async def _switch(self, name: str) -> None:
        async with self.lock:
            old = self.active
            self.active = name
            self.set(name, "loading")
            self.switches += 1
            try:
                if old and old != name:
                    deadline = self.clock() + DRAIN_S
                    while self.inflight[old] and self.clock() < deadline:
                        await asyncio.sleep(0.1)
                    self.set(old, "unloading")
                    self.log(f"tts engine: {old} → {name}, unloading {old}")
                    try:
                        await self.engines[old].unload()
                        self.set(old, "unloaded")
                    except Exception as error:  # noqa: BLE001 — a failed unload is reported; the new engine still loads
                        self.set(old, "failed", f"unload: {error!r}")
                self.log(f"tts engine: loading {name}")
                await self.engines[name].load()
                self.set(name, "loaded")
                self.last_used[name] = self.clock()  # the idle window starts once it can serve
                self.log(f"tts engine: {name} loaded")
            except Exception as error:  # noqa: BLE001
                self.set(name, "failed", repr(error))
                self.active = None
                self.log(f"tts engine: {name} failed: {error!r}")
            finally:
                self.target = None

    async def adopt(self, name: str, warm) -> None:
        """Boot: the engine start.sh already started (Qwen3-TTS) becomes the active one once `warm()` succeeds."""
        async with self.lock:
            self.active = name
            self.set(name, "loading")
            try:
                await warm()
                self.set(name, "loaded")
                self.last_used[name] = self.clock()
            except Exception as error:  # noqa: BLE001
                self.set(name, "failed", repr(error))
                self.active = None
                raise

    async def select(self, name: str, force: bool = False, wait: bool = False) -> dict:
        """Make `name` the active engine (the gateway, at the start of an app's session)."""
        if name not in self.engines:
            return {"ok": False, "code": "unknown_engine", "message": f"engine must be one of {', '.join(self.engines)}"}
        if self.active == name or self.target == name:
            if wait and self.task:
                await asyncio.shield(self.task)
            return {"ok": True, **self.view()}
        busy = self.target or (self.active if self.active and self.idle_for(self.active) < self.switch_idle_s else None)
        if busy and not force:
            return {"ok": False, "code": "in_use", "message": f"{busy} is in use (idle for less than {self.switch_idle_s:.0f} s): "
                    f"send force to switch anyway", **self.view()}
        if self.target and force and self.task:
            await asyncio.shield(self.task)  # one switch at a time; this one follows
        self._start_switch(name)
        if wait and self.task:
            await asyncio.shield(self.task)
        return {"ok": True, **self.view()}

    def admit(self, name: str) -> Admit:
        """A request for `name`: served now, or a quick refusal (and maybe a switch started for the next ones)."""
        if name not in self.engines:
            return Admit(False, "engine_disabled", f"the {name} TTS engine is not enabled on this replica")
        if self.target and self.target != name:
            return Admit(False, "tts_engine_busy", f"switching to {self.target}", LOAD_RETRY_S.get(self.target, 30))
        if self.loaded(name):
            return Admit(True)
        if self.active == name or self.target == name:
            return Admit(False, "tts_engine_loading", f"the {name} TTS engine is loading", LOAD_RETRY_S.get(name, 30))
        if self.active and self.idle_for(self.active) < self.switch_idle_s:
            return Admit(False, "tts_engine_busy", f"this replica speaks with {self.active} now; {name} is not loaded",
                         max(1, round(self.switch_idle_s - self.idle_for(self.active))))
        self._start_switch(name)
        return Admit(False, "tts_engine_loading", f"loading the {name} TTS engine", LOAD_RETRY_S.get(name, 30))
