"""Unit test of the streaming JSON field extractor (no GPU): python3 docker/speech-stack/test_json_field.py"""
from pathlib import Path

src = Path(__file__).with_name("server.py").read_text()
ns: dict = {}
exec(src[src.index("class JsonField:"):src.index("async def llm_stream")], ns)
JsonField = ns["JsonField"]


def run(text: str, step: int, key: str = "utterance") -> tuple[str, bool]:
    f, out, closed = JsonField(key), "", False
    for i in range(0, len(text), step):
        part, c = f.push(text[i:i + step])
        out += part
        closed = closed or c
    return out, closed


CASES = [
    ('{"utterance": "Bom dia! Tudo bem?", "mood": "happy"}', "Bom dia! Tudo bem?"),
    ('```json\n{"mood": "x", "utterance": "Diz \\"oi\\"\\nlinha"}', 'Diz "oi"\nlinha'),
    ('<think>{"utterance": "não"}</think>{"utterance": "sim, p\\u00e3o"}', "sim, pão"),
    ('{"meta": {"utterance": "aninhado"}, "utterance": "raiz"}', "raiz"),
    ('{"mood": "calm"}', ""),
]
for text, expected in CASES:
    for step in (1, 2, 3, 7, 50):
        got, closed = run(text, step)
        assert got == expected, (text, step, got)
        assert closed, (text, step)
print("json field: ok", len(CASES), "cases × 5 chunk sizes")
