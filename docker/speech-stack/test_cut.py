"""Unit test of the sentence cutter (no GPU): python3 docker/speech-stack/test_cut.py"""
import os
import re
from pathlib import Path

src = Path(__file__).with_name("server.py").read_text()


def load(eager: str):
    os.environ["CUT_EAGER"] = eager
    ns: dict = {}
    exec("import os\nimport re\nFIRST_MIN_WORDS=3\nMAX_CHUNK_CHARS=160\n"
         + src[src.index("SENTENCE_END ="):src.index("LLM_TIMINGS =")], ns)
    return ns["cut"]


cut = load("0")


def run(text: str, step: int = 1) -> list[str]:
    out, buf, first = [], "", True
    for i in range(0, len(text), step):
        buf += text[i:i + step]
        while True:
            chunk, buf = cut(buf, first, False)
            if not chunk:
                break
            out.append(chunk)
            first = False
    chunk, _ = cut(buf, first, True)
    if chunk:
        out.append(chunk)
    return out


CASES = {
    "Bom dia, querida! Hoje tem pão francês, integral e broa de milho. Qual você quer?":
        ["Bom dia, querida!", "Hoje tem pão francês, integral e broa de milho.", "Qual você quer?"],
    "Olá, tudo bem com você hoje, amiga? Sim.": ["Olá, tudo bem com você hoje,", "amiga? Sim."],
    "O Dr. Silva chegou às 9h30. Pode entrar.": ["O Dr. Silva chegou às 9h30.", "Pode entrar."],
    "Custa 3.50 reais, tá bom?": ["Custa 3.50 reais,", "tá bom?"],
    "Sim.": ["Sim."],
}
for text, expected in CASES.items():
    assert run(text, 1) == expected, (text, run(text, 1))
    for step in (1, 2, 3, 5, 7, 11):  # token sizes vary: the cut may differ, the properties may not
        got = run(text, step)
        assert " ".join(got) == " ".join(text.split()), (text, step, got)  # nothing lost or duplicated
        assert all(len(c.split()) >= 2 for c in got[:-1]), (text, step, got)  # no one-word chunk before the last
        assert not any(c.endswith("Dr.") for c in got), (text, step, got)  # abbreviations never end a chunk
        assert len(got[0]) <= len(expected[0]) + 10, (text, step, got)  # the first chunk stays short
assert cut("Bom dia!", True, False) == (None, "Bom dia!")
cut = load("1")
assert cut("Bom dia!", True, False) == ("Bom dia!", "")
assert cut("Tudo bem?", False, False) == ("Tudo bem?", "")
assert cut("Custa 3.", True, False) == (None, "Custa 3.")
assert cut("Pode entrar.", True, False) == (None, "Pode entrar.")
assert cut("Amiga?", True, False) == (None, "Amiga?")
assert cut('Ela disse "oi!"', True, False) == (None, 'Ela disse "oi!"')
for text, expected in CASES.items():
    for step in (1, 2, 3, 5, 7, 11):
        got = run(text, step)
        assert " ".join(got) == " ".join(text.split()), (text, step, got)
        assert all(len(c.split()) >= 2 for c in got[:-1]), (text, step, got)
        assert not any(c.endswith("Dr.") for c in got), (text, step, got)
assert run("Bom dia, querida! Qual você quer?", 1)[0] == "Bom dia, querida!"
print("cut: ok", len(CASES), "cases × 6 token sizes, eager and not")
