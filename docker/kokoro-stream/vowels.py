import re
from pathlib import Path

VERB_CONTEXT = {"eu", "tu", "ele", "ela", "você", "gente", "não", "me", "te", "se", "lhe", "nos"}
VOWELS = set("aɐæeɛiɪoɔuʊyAIWãẽĩõũ")
FAMILY = {"e": "E", "ɛ": "E", "o": "O", "ɔ": "O"}
ACCENTED = {"e": ("é", "ê"), "o": ("ó", "ô")}
DIMINUTIVE = re.compile(r"^(.+?)zinh([oa])s?$")


def load(path: Path) -> dict[str, tuple[str, str | None]]:
    table = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#"):
            continue
        word, default, *verb = line.split("\t")
        table[word] = (default, verb[0] if verb else None)
    return table


TABLE = load(Path(__file__).with_name("pt_vowels.tsv"))


def quality(word: str, previous: str | None) -> str | None:
    default, verb = TABLE.get(word, (None, None))
    return verb if verb and previous in VERB_CONTEXT else default


def diminutive_quality(word: str) -> str | None:
    match = DIMINUTIVE.match(word)
    if not match:
        return None
    stem, ending = match.groups()
    candidates = [stem]
    if stem[-1] in ACCENTED:
        open_vowel, closed_vowel = ACCENTED[stem[-1]]
        order = (open_vowel, closed_vowel) if ending == "a" else (closed_vowel, open_vowel)
        candidates = [stem[:-1] + accent for accent in order]
    return next((TABLE[c][0] for c in candidates if c in TABLE), None)


def with_quality(phonemes: str, start: int, wanted: str) -> str:
    for i in range(start, len(phonemes)):
        if phonemes[i] not in VOWELS:
            continue
        nasal = phonemes[i + 1 : i + 2] == "̃"
        if nasal or FAMILY.get(phonemes[i]) != FAMILY[wanted]:
            return phonemes
        return phonemes[:i] + wanted + phonemes[i + 1 :]
    return phonemes


def fix_word(word: str, phonemes: str, previous: str | None) -> str:
    if wanted := quality(word, previous):
        stress = phonemes.find("ˈ")
        return phonemes if stress < 0 else with_quality(phonemes, stress + 1, wanted)
    wanted, suffix = diminutive_quality(word), phonemes.find("zˈi")
    vowels_before = [i for i, c in enumerate(phonemes[: max(suffix, 0)]) if c in VOWELS]
    return with_quality(phonemes, vowels_before[-1], wanted) if wanted and vowels_before else phonemes


def fix(text: str, phonemes: str) -> str:
    words = [w for w in (re.sub(r"^\W+|\W+$", "", t).lower() for t in text.split()) if w]
    tokens = phonemes.split(" ")
    spoken = [i for i, t in enumerate(tokens) if any(c.isalpha() for c in t)]
    if len(words) != len(spoken):
        return phonemes
    previous = None
    for word, i in zip(words, spoken):
        tokens[i] = fix_word(word, tokens[i], previous)
        previous = word
    return " ".join(tokens)
