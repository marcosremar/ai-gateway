import json
import re
import time
from pathlib import Path

CODES = {"en": "eng", "fr": "fra", "pt": "por", "es": "spa", "it": "ita", "de": "deu", "nl": "nld"}

MODELS = {
    "en-itc": "Helsinki-NLP/opus-mt-tc-bible-big-deu_eng_fra_por_spa-itc",
    "roa-en": "Helsinki-NLP/opus-mt-tc-bible-big-roa-en",
    "itc-multi": "Helsinki-NLP/opus-mt-tc-bible-big-itc-deu_eng_fra_por_spa",
    "gem-multi": "Helsinki-NLP/opus-mt-tc-bible-big-gem-deu_eng_fra_por_spa",
}

SENTENCE_END = re.compile(r"(?<=[.!?…])\s+(?=[\"'«“(\[]?[A-ZÀ-Ý0-9])")


def model_for(source: str, target: str) -> str | None:
    if (source, target) in {("en", "fr"), ("en", "pt"), ("en", "it"), ("fr", "es"), ("pt", "es"), ("fr", "it"), ("pt", "it"),
                            ("es", "it"), ("de", "fr"), ("de", "pt"), ("de", "es"), ("de", "it")}:
        return "en-itc"
    if source in {"fr", "pt", "es", "it"} and target == "en":
        return "roa-en"
    if (source, target) in {("fr", "pt"), ("pt", "fr"), ("es", "fr"), ("es", "pt"), ("it", "fr"), ("it", "pt"), ("it", "es")} \
            or (source in {"fr", "pt", "es", "it"} and target == "de"):
        return "itc-multi"
    if (source == "nl" and target in {"de", "fr", "pt", "es"}) or (source, target) == ("en", "de"):
        return "gem-multi"
    return None


def sentences(text: str) -> list[str]:
    return [part.strip() for part in SENTENCE_END.split(text.strip()) if part.strip()]


def without_added_dash(source: str, translated: str) -> str:
    if re.match(r"^[-–—]\s", translated) and not re.match(r"^[-–—]\s", source):
        return translated[2:].lstrip()
    return translated


def target_tokens(model_dir: Path) -> set[str]:
    for name in ("shared_vocabulary.json", "target_vocabulary.json", "shared_vocabulary.txt", "target_vocabulary.txt"):
        path = model_dir / name
        if not path.exists():
            continue
        pieces = json.loads(path.read_text()) if name.endswith(".json") else path.read_text().split("\n")
        return {p for p in pieces if p.startswith(">>") and p.endswith("<<")}
    return set()


class Model:
    def __init__(self, name: str, model_dir: Path, gpu_compute: str, cpu_compute: str, cpu_threads: int):
        import ctranslate2
        import sentencepiece

        self.name = name
        self.source = sentencepiece.SentencePieceProcessor(model_file=str(model_dir / "source.spm"))
        self.target = sentencepiece.SentencePieceProcessor(model_file=str(model_dir / "target.spm"))
        self.targets = target_tokens(model_dir)
        self.gpu = ctranslate2.Translator(str(model_dir), device="cuda", compute_type=gpu_compute) if gpu_compute else None
        self.cpu = ctranslate2.Translator(str(model_dir), device="cpu", compute_type=cpu_compute, inter_threads=1,
                                          intra_threads=cpu_threads)

    def tokens(self, sentence: str, target: str) -> list[str]:
        prefix = f">>{CODES.get(target, target)}<<"
        pieces = [*self.source.encode(sentence, out_type=str), "</s>"]
        return [prefix, *pieces] if prefix in self.targets else pieces

    def run(self, translator, batch: list[list[str]], beam: int) -> list[str]:
        results = translator.translate_batch(batch, beam_size=beam, max_decoding_length=256)
        return [self.target.decode(r.hypotheses[0]) for r in results]


class Translator:
    def __init__(self, root: Path, names: list[str], gpu_compute: str = "int8_float16", cpu_compute: str = "int8",
                 cpu_threads: int = 2, beam: int = 1):
        self.models = {name: Model(name, root / name, gpu_compute, cpu_compute, cpu_threads) for name in names}
        self.beam = beam
        self.stats = {"calls": 0, "sentences": 0, "gpu_failures": 0, "cpu_calls": 0, "ms_total": 0.0, "last_error": None}

    def translate(self, text: str, source: str, target: str) -> dict:
        name = model_for(source, target)
        if name is None or name not in self.models:
            raise KeyError(f"no text translator for {source}->{target}")
        model = self.models[name]
        parts = sentences(text)
        if not parts:
            return {"text": "", "model": name, "device": "none", "ms": 0.0}
        batch = [model.tokens(part, target) for part in parts]
        started = time.perf_counter()
        device = "cuda"
        try:
            if model.gpu is None:
                raise RuntimeError("no gpu copy")
            outputs = model.run(model.gpu, batch, self.beam)
        except Exception as error:  # noqa: BLE001
            self.stats["gpu_failures"] += model.gpu is not None
            self.stats["last_error"] = repr(error)[:200]
            device = "cpu"
            self.stats["cpu_calls"] += 1
            outputs = model.run(model.cpu, batch, self.beam)
        ms = (time.perf_counter() - started) * 1000
        self.stats["calls"] += 1
        self.stats["sentences"] += len(parts)
        self.stats["ms_total"] += ms
        joined = " ".join(without_added_dash(src, out) for src, out in zip(parts, outputs))
        return {"text": joined, "model": name, "device": device, "ms": round(ms, 1)}
