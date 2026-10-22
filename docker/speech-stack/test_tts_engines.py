"""One TTS engine at a time (tts_engines.py), with fake engines and a fake clock: python3 docker/speech-stack/test_tts_engines.py
No GPU, no models, stdlib only."""
import asyncio

from tts_engines import EngineManager, engine_of

log: list[str] = []


class Fake:
    def __init__(self, name: str, fail: bool = False):
        self.name, self.fail, self.loaded = name, fail, False

    async def load(self):
        await asyncio.sleep(0.01)
        if self.fail:
            raise RuntimeError(f"{self.name} would not start")
        self.loaded = True
        log.append(f"load {self.name}")

    async def unload(self):
        await asyncio.sleep(0.01)
        self.loaded = False
        log.append(f"unload {self.name}")


async def settle(m: EngineManager):
    while m.task and not m.task.done():
        await asyncio.sleep(0.005)


async def main():
    assert [engine_of(m) for m in ("kokoro", "hexgrad/Kokoro-82M", "pocket", "babelcast-pocket", "Qwen/Qwen3-TTS-12Hz-0.6B-Base", None)] == \
        ["kokoro", "kokoro", "pocket", "pocket", "qwen", "qwen"]
    now = [0.0]
    engines = {"qwen": Fake("qwen"), "kokoro": Fake("kokoro"), "pocket": Fake("pocket")}
    m = EngineManager(engines, switch_idle_s=120, clock=lambda: now[0], log=lambda line: None)

    # Boot: start.sh's Qwen3-TTS is adopted once warm.
    async def warm():
        engines["qwen"].loaded = True
    await m.adopt("qwen", warm)
    assert m.active == "qwen" and m.admit("qwen").ok

    # Right after boot, a Kokoro request does not unload a Qwen that has not had its idle window yet.
    verdict = m.admit("kokoro")
    assert (verdict.ok, verdict.code) == (False, "tts_engine_busy") and verdict.retry_after == 120, verdict
    with m.use("qwen"):
        now[0] += 500
        assert m.admit("pocket").code == "tts_engine_busy", "a sentence in flight keeps its engine"
    now[0] += 60
    assert m.admit("pocket").code == "tts_engine_busy", "60 s idle is not enough"
    assert (await m.select("pocket"))["code"] == "in_use", "the select endpoint follows the same rule without force"

    # Idle long enough: the request starts the switch and is itself refused at once (the gateway falls back).
    now[0] += 61
    verdict = m.admit("pocket")
    assert (verdict.ok, verdict.code) == (False, "tts_engine_loading") and verdict.retry_after == 15, verdict
    assert m.admit("pocket").code == "tts_engine_loading" and m.admit("qwen").code == "tts_engine_busy"
    await settle(m)
    assert log == ["unload qwen", "load pocket"] and not engines["qwen"].loaded and engines["pocket"].loaded, log
    assert m.admit("pocket").ok and m.view()["engines"]["qwen"]["status"] == "unloaded"
    assert m.view()["active"] == "pocket" and m.switches == 1

    # Explicit choice with force switches now, waiting for the sentence in flight before unloading.
    log.clear()
    order: list[str] = []

    async def speak():
        with m.use("pocket"):
            await asyncio.sleep(0.05)
            order.append("sentence done")
    sentence = asyncio.ensure_future(speak())
    await asyncio.sleep(0)
    answer = await m.select("kokoro", force=True)
    assert answer["ok"] and answer["switching_to"] == "kokoro"
    await settle(m)
    await sentence
    assert order == ["sentence done"] and log == ["unload pocket", "load kokoro"], (order, log)
    assert m.admit("kokoro").ok and (await m.select("kokoro"))["ok"], "selecting the active engine is a no-op"

    # A failed load leaves no active engine: the next request (any engine) loads at once.
    engines["qwen"].fail = True
    now[0] += 1000
    await m.select("qwen", wait=True)
    assert m.active is None and m.view()["engines"]["qwen"]["status"] == "failed" and "would not start" in m.view()["engines"]["qwen"]["detail"]
    log.clear()
    assert m.admit("kokoro").code == "tts_engine_loading"
    await settle(m)
    assert m.admit("kokoro").ok and log == ["load kokoro"], log
    assert (await m.select("nope"))["code"] == "unknown_engine"

    only = EngineManager({"qwen": Fake("qwen")}, clock=lambda: now[0], log=lambda line: None)
    assert only.admit("pocket").code == "engine_disabled"
    print("tts engines: ok — one engine loaded at a time, switch only after the idle window (or a forced select), "
          "in-flight sentences drained first, quick refusals meanwhile, a failed load frees the slot")


asyncio.run(main())
