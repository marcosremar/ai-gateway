"""Pocket TTS (Kyutai, CPU) next to Kokoro in the same speech server.

`POST /v1/audio/speech` with `"model": "pocket"` goes here (server.py); everything else is Kokoro. Off unless
`POCKET_TTS=1`, so an image built without it (no torch, no pocket-tts) keeps serving Kokoro.

- One Pocket model per language (`pocket_tts` loads `config/<language>.yaml`, ~220 MB of weights each). A language is
  loaded in a background thread: at start for `POCKET_PRELOAD` (comma list of ISO codes), else on its first request,
  which gets 503 `loading` at once so the gateway speaks that line with its next link (Kokoro) instead of waiting.
- The model is not thread-safe: one sentence at a time per language. A second request waits up to `POCKET_WAIT_S`
  (default 2 s) for it, then gets 503 `busy`.
- Predefined voices only (`rafael`, `estelle`, `alba`…; the "without voice cloning" weights, public, no HF token).
  Any voice speaks any language with an accent; the gateway sends the language's own voice unless the app names one.
- Audio: the model's stream of float chunks as 24 kHz s16le PCM, from the first chunk. `speed` is accepted and ignored
  (Pocket has no speed control).
- Memory: a language not used for `POCKET_IDLE_UNLOAD_S` (default 900 s; 0 = never) is unloaded — its model and voice
  states dropped and the memory given back (gc, `malloc_trim`, CUDA cache) — and loads again on its next request (503
  `loading` meanwhile). Preloaded languages too: `POCKET_PRELOAD` only spares the first request after a start.
- `POCKET_DEVICE` (default `cpu`): `cuda` moves each loaded model to the GPU (experimental; Pocket is built for CPU).

The same file is vendored in docker/speech-stack (the GPU image's Pocket sidecar); test_pocket_vendored.py there keeps
the two copies identical.
"""

from __future__ import annotations

import gc
import os
import sys
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any

import numpy as np

LANGUAGES = {"en": "english", "fr": "french", "de": "german", "pt": "portuguese", "es": "spanish", "it": "italian", "nl": "dutch"}
LANGUAGE_NAMES = {name: code for code, name in LANGUAGES.items()}

# pocket_tts 3.3 `_ORIGINS_OF_PREDEFINED_VOICES`, with the language each voice was recorded in.
VOICES = {
    "rafael": "pt", "estelle": "fr", "lola": "es", "giovanni": "it", "juergen": "de", "daan": "nl",
    "alba": "en", "marius": "en", "javert": "en", "jean": "en", "fantine": "en", "cosette": "en", "eponine": "en", "azelma": "en",
    "anna": "en", "vera": "en", "charles": "en", "paul": "en", "george": "en", "mary": "en", "jane": "en", "michael": "en", "eve": "en",
    "bill_boerst": "en", "peter_yearsley": "en", "stuart_bell": "en", "caro_davy": "en",
}

# Same table as the gateway (src/gateway/providers/cloud/kokoro-stream/route-tts.ts `POCKET_DEFAULT_VOICES`): baked
# into the image and warmed first.
DEFAULT_VOICES = {
    "pt": ("rafael", "estelle"), "fr": ("jean", "estelle"), "es": ("rafael", "lola"), "it": ("giovanni", "lola"),
    "de": ("juergen", "alba"), "en": ("marius", "alba"), "nl": ("daan", "alba"),
}

MODELS = {"pocket", "pocket-tts", "kyutai/pocket-tts"}
WARM_UP = {"en": "Hello.", "fr": "Bonjour.", "de": "Hallo.", "pt": "Olá.", "es": "Hola.", "it": "Ciao.", "nl": "Hallo."}
RETRY_FAILED_S = 60.0
DEFAULT_IDLE_UNLOAD_S = 900.0


def language_code(value: Any) -> str | None:
    """"Portuguese" / "pt-BR" / "pt" → "pt"; None for anything Pocket does not speak."""
    if not isinstance(value, str) or not value.strip():
        return None
    v = value.strip().lower()
    code = LANGUAGE_NAMES.get(v) or v.replace("_", "-").split("-")[0]
    return code if code in LANGUAGES else None


def codes(value: str) -> list[str]:
    return [c for c in (language_code(p) for p in value.split(",")) if c]


def to_pcm(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def load_language(lang: str, threads: int, quantize: bool, device: str = "cpu") -> Any:
    import torch
    from pocket_tts import TTSModel

    torch.set_num_threads(threads)
    model = TTSModel.load_model(language=LANGUAGES[lang], quantize=quantize)
    return model.to(device) if device != "cpu" else model


def give_memory_back() -> None:
    """After a model is dropped: collect it, return freed heap pages to the OS (glibc) and empty the CUDA cache."""
    gc.collect()
    try:
        import ctypes

        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass
    torch = sys.modules.get("torch")
    if torch is not None and getattr(torch, "cuda", None) is not None and torch.cuda.is_available():
        torch.cuda.empty_cache()


class Pocket:
    def __init__(self, enabled: bool, loader: Callable[[str], Any], preload: list[str] | None = None, wait_s: float = 2.0,
                 idle_unload_s: float = DEFAULT_IDLE_UNLOAD_S, clock: Callable[[], float] = time.monotonic):
        self.enabled = enabled
        self.loader = loader
        self.preload_languages = preload or []
        self.wait_s = wait_s
        self.idle_unload_s = idle_unload_s
        self.clock = clock
        self.last_used: dict[str, float] = {}
        self.reaper: threading.Thread | None = None
        self.models: dict[str, Any] = {}
        self.states: dict[tuple[str, str], Any] = {}
        self.status: dict[str, str] = {}
        self.failed_at: dict[str, float] = {}
        self.errors: dict[str, str] = {}
        self.locks = {lang: threading.Lock() for lang in LANGUAGES}
        self.guard = threading.Lock()

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Pocket:
        env = dict(os.environ if env is None else env)
        threads = int(env.get("POCKET_THREADS", "4"))
        quantize = env.get("POCKET_QUANTIZE") == "1"
        device = env.get("POCKET_DEVICE", "cpu") or "cpu"
        return cls(
            enabled=env.get("POCKET_TTS") == "1",
            loader=lambda lang: load_language(lang, threads, quantize, device),
            preload=codes(env.get("POCKET_PRELOAD", "")),
            wait_s=float(env.get("POCKET_WAIT_S", "2")),
            idle_unload_s=float(env.get("POCKET_IDLE_UNLOAD_S", str(DEFAULT_IDLE_UNLOAD_S))),
        )

    def preload(self) -> None:
        """At start: loads the `POCKET_PRELOAD` languages and starts the idle reaper."""
        if self.enabled:
            for lang in self.preload_languages:
                self.model(lang)
            self.start_reaper()

    def start_reaper(self) -> None:
        if self.idle_unload_s <= 0 or self.reaper is not None:
            return
        period = max(1.0, min(60.0, self.idle_unload_s / 4))

        def loop() -> None:
            while True:
                time.sleep(period)
                self.unload_idle()

        self.reaper = threading.Thread(target=loop, name="pocket-idle-unload", daemon=True)
        self.reaper.start()

    def unload_idle(self) -> list[str]:
        """Unloads every language idle for `idle_unload_s` and not speaking now; returns them."""
        if self.idle_unload_s <= 0:
            return []
        now = self.clock()
        idle = [lang for lang in list(self.models) if now - self.last_used.get(lang, now) >= self.idle_unload_s]
        return [lang for lang in idle if self.unload(lang)]

    def unload(self, lang: str) -> bool:
        """Drops a language's model and voice states (False while it is speaking a sentence)."""
        if not self.locks[lang].acquire(blocking=False):
            return False
        try:
            with self.guard:
                if lang not in self.models:
                    return False
                del self.models[lang]
                for key in [k for k in self.states if k[0] == lang]:
                    del self.states[key]
                self.status[lang] = "unloaded"
                self.last_used.pop(lang, None)
        finally:
            self.locks[lang].release()
        give_memory_back()
        print(f"pocket: {lang} unloaded (idle)", flush=True)
        return True

    def model(self, lang: str) -> Any | None:
        """The loaded model, or None while it loads (a load starts in the background if none is running)."""
        with self.guard:
            if lang in self.models:
                return self.models[lang]
            if self.status.get(lang) == "loading":
                return None
            if self.status.get(lang) == "failed" and time.monotonic() - self.failed_at.get(lang, 0) < RETRY_FAILED_S:
                return None
            self.status[lang] = "loading"
        threading.Thread(target=self._load, args=(lang,), name=f"pocket-load-{lang}", daemon=True).start()
        return None

    def _load(self, lang: str) -> None:
        try:
            model = self.loader(lang)
            voice = DEFAULT_VOICES[lang][1]
            state = model.get_state_for_audio_prompt(voice)
            for _ in model.generate_audio_stream(state, WARM_UP[lang]):
                pass
            with self.guard:
                self.models[lang] = model
                self.states[(lang, voice)] = state
                self.status[lang] = "loaded"
                self.last_used[lang] = self.clock()
                self.errors.pop(lang, None)
        except Exception as err:  # noqa: BLE001 — reported on /health, retried after RETRY_FAILED_S
            print(f"pocket: loading {lang} failed: {err}", file=sys.stderr, flush=True)
            with self.guard:
                self.status[lang] = "failed"
                self.failed_at[lang] = time.monotonic()
                self.errors[lang] = str(err)[:200]

    def voice_state(self, lang: str, voice: str) -> Any:
        key = (lang, voice)
        if key not in self.states:
            self.states[key] = self.models[lang].get_state_for_audio_prompt(voice)
        return self.states[key]

    def acquire(self, lang: str) -> bool:
        got = self.locks[lang].acquire(timeout=self.wait_s)
        if got:
            self.last_used[lang] = self.clock()
        return got

    def release(self, lang: str) -> None:
        self.last_used[lang] = self.clock()
        self.locks[lang].release()

    def rate(self, lang: str) -> int:
        return int(getattr(self.models[lang], "sample_rate", 24_000))

    def speak(self, lang: str, voice: str, text: str, stop: threading.Event | None = None) -> Iterator[bytes]:
        model = self.models[lang]
        for chunk in model.generate_audio_stream(self.voice_state(lang, voice), text, stop=stop):
            samples = chunk.numpy() if hasattr(chunk, "numpy") else np.asarray(chunk)
            yield to_pcm(np.asarray(samples, dtype=np.float32).reshape(-1))

    def health(self) -> dict:
        return {
            "enabled": self.enabled,
            "languages": {lang: self.status.get(lang, "not_loaded") for lang in LANGUAGES},
            "idle_unload_s": self.idle_unload_s,
            **({"errors": dict(self.errors)} if self.errors else {}),
        }


def bake(languages: list[str]) -> None:
    """Image build: downloads each language's weights and its default voices into HF_HOME (no network at start)."""
    for lang in languages:
        model = load_language(lang, int(os.environ.get("POCKET_THREADS", "4")), False)
        for voice in DEFAULT_VOICES[lang]:
            model.get_state_for_audio_prompt(voice)
        print(f"pocket: {lang} baked", flush=True)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "bake":
        bake(codes(sys.argv[2]))
    else:
        sys.exit("usage: python pocket.py bake pt,fr,en,es,it,de")
