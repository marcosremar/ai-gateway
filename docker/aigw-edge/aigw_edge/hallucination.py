"""
STT hallucination guard — a Python port of the gateway's src/stt-hallucination-filter.ts (metadata + blocklist layers)
and src/stt-hallucination-patterns.ts (credit lines, music symbols, short loops), with the same thresholds, the same
core blocklist (whisper-hallucinations.core.json, copied from src/data/; tests/test_units.py checks the copy) and the same
reason codes. The rationale and sources of every threshold live in those files and docs/stt-hallucination-filter.md:
Radford et al. (2023), ICML, arXiv:2212.04356 (no_speech_prob 0.6, compression_ratio 2.4); Koenecke et al. (2024),
ACM FAccT, DOI 10.1145/3630106.3658996; blocklist sachaarbonel/whisper-hallucinations.

    text, codes = filter_transcript(heard_text, "pt", {"no_speech_prob": .., "avg_logprob": .., "compression_ratio": ..})
    # text == "" and codes non-empty → the turn is dropped (event `filtered`, then `done{filtered: true}`)
"""

import json
import re
import unicodedata
from pathlib import Path

NO_SPEECH_PROB = 0.6
COMPRESSION_RATIO = 2.4
AVG_LOGPROB = -0.8
AMBIGUOUS_NO_SPEECH_PROB = 0.4

BOILERPLATE = re.compile(r"amara|legenda|subtitle|sous titres|inscreva|inscrever|abonn|assistir|regarder|regard|watching|"
                         r"subscribe|canal|cha[iî]ne|channel|notific|sininho|instagram|like e|vídeo|video|tipeeee")
ALWAYS_BLOCK = {"pt": ["e aí", "obrigado por assistir", "obrigada por assistir"]}
LEARNER_SAFE = {
    "sim", "não", "nao", "oi", "olá", "ola", "obrigado", "obrigada", "tchau", "bom dia", "boa tarde", "boa noite", "por favor",
    "oui", "non", "merci", "bonjour", "salut", "au revoir", "s il vous plaît", "bonsoir",
    "yes", "no", "hello", "hi", "thanks", "thank you", "bye", "okay", "ok", "good morning", "please",
}
LANGUAGE_NAMES = {
    "portuguese": "pt", "português": "pt", "portugues": "pt", "french": "fr", "français": "fr", "francais": "fr",
    "english": "en", "spanish": "es", "español": "es", "german": "de", "italian": "it",
}


def _high_confidence(lang: str, phrase: str) -> bool:
    if phrase in ALWAYS_BLOCK.get(lang, []):
        return True
    if phrase in LEARNER_SAFE:
        return False
    return len(phrase.split(" ")) >= 6 or bool(BOILERPLATE.search(phrase))


_data: dict[str, list[str]] = json.loads((Path(__file__).with_name("whisper-hallucinations.core.json")).read_text())
HIGH: set[str] = set()
AMBIGUOUS: dict[str, set[str]] = {}
for _lang, _phrases in _data.items():
    AMBIGUOUS[_lang] = set()
    for _p in _phrases:
        (HIGH.add(_p) if _high_confidence(_lang, _p) else AMBIGUOUS[_lang].add(_p))
    HIGH.update(ALWAYS_BLOCK.get(_lang, []))


def normalize_language(language: str | None) -> str | None:
    if not isinstance(language, str) or not language.strip():
        return None
    v = language.strip().lower()
    if v in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[v]
    code = re.split(r"[-_]", v)[0]
    return code if code in AMBIGUOUS else None


_PUNCT = re.compile(r"[^\w']+")


def normalize_for_blocklist(text: str) -> str:
    """lowercase, punctuation → space, apostrophes kept (the TS `[^\\p{L}\\p{N}']+`; `_` also counts as punctuation)."""
    t = unicodedata.normalize("NFC", text).lower()
    t = re.sub(r"[’‘`´]", "'", t)
    return _PUNCT.sub(" ", t).replace("_", " ").strip()


# ── Pattern rules (stt-hallucination-patterns.ts) ────────────────────────────

CREDIT_LINES = [re.compile(p) for p in (
    r"^legendas? (por|pela|pelo|de|da|do|feitas?|criadas?|realizadas?)(?! favor\b)\b",
    r"^legendad[oa]s? (por|pela|pelo)\b",
    r"^(tradução|transcrição) e legendas?\b",
    r"^legendas pela comunidade\b",
    r"^sous titres? (réalisés?|réalisé|faits?|par|fait|de|créés?)\b",
    r"^sous titrage\b",
    r"^(subtitles?|captions?|closed captions?|subtitled|captioned|transcribed|transcription|translated) by\b",
    r"^subt[ií]tulos? (por|de|realizados?|hechos?|creados?|en espa[ñn]ol)\b",
    r"^subtitulad[oa] por\b",
)]
CREDIT_MAX_WORDS = 12
MUSIC_CHARS = set("♪♫♬♩🎵🎶")
LOOP_COVERAGE = 0.7


def _longest_loop(words: list[str]):
    for size in (1, 2, 3):
        for start in range(0, len(words) - size + 1):
            phrase = words[start:start + size]
            repeats = 1
            while words[start + repeats * size:start + (repeats + 1) * size] == phrase:
                repeats += 1
            needed = 4 if size == 1 else 3
            if repeats >= needed and (repeats * size) / len(words) >= LOOP_COVERAGE:
                return size, repeats
    return None


def pattern_verdict(raw: str, normalized: str) -> str | None:
    if not normalized and not any(c in MUSIC_CHARS for c in raw):
        return None
    words = normalized.split(" ") if normalized else []
    if normalized and len(words) <= CREDIT_MAX_WORDS and any(r.search(normalized) for r in CREDIT_LINES):
        return "pattern_credits"
    chars = list(raw.strip())
    symbols = sum(1 for c in chars if c in MUSIC_CHARS)
    if symbols and (chars[0] in MUSIC_CHARS or chars[-1] in MUSIC_CHARS or len(words) <= 3 * symbols or _longest_loop(words)):
        return "music"
    if words and _longest_loop(words):
        return "repetition"
    return None


def filter_transcript(text: str, language: str | None, meta: dict | None = None) -> tuple[str, list[str]]:
    """(kept text, reason codes). Empty kept text with codes = hallucination; empty text without codes = silence."""
    lang = normalize_language(language)
    meta = meta or {}
    codes: list[str] = []
    original = text or ""
    out = original
    nsp, cr, lp = meta.get("no_speech_prob"), meta.get("compression_ratio"), meta.get("avg_logprob")
    if out and any(v is not None for v in (nsp, cr, lp)):
        # One flat set of metrics (the speech-stack's) is judged as a single segment, like the TS filter.
        if (nsp or 0) > NO_SPEECH_PROB:
            codes.append("no_speech_prob")
        elif (cr or 0) > COMPRESSION_RATIO:
            codes.append("compression_ratio")
        elif (lp if lp is not None else 0) < AVG_LOGPROB:
            codes.append("avg_logprob")
        if codes:
            out = ""
    if out:
        n = normalize_for_blocklist(out)
        if n in HIGH:
            codes.append("blocklist")
            out = ""
        elif lang and n not in LEARNER_SAFE and n in AMBIGUOUS.get(lang, set()) and (nsp or 0) >= AMBIGUOUS_NO_SPEECH_PROB:
            codes.append("blocklist_corroborated")
            out = ""
    if out:
        verdict = pattern_verdict(out, normalize_for_blocklist(out))
        if verdict:
            codes.append(verdict)
            out = ""
    return out, codes


if __name__ == "__main__":
    # Parity hook for the gateway's tests (__tests__/unit/realtime-edge/filter-parity.test.ts): JSON cases on stdin
    # [{text, language, meta}] → [{text, codes}] on stdout. Standard library only.
    import sys

    cases = json.load(sys.stdin)
    json.dump([dict(zip(("text", "codes"), filter_transcript(c["text"], c.get("language"), c.get("meta")))) for c in cases],
              sys.stdout, ensure_ascii=False)
