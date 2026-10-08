"""
Sentence cutter, streaming JSON-field extractor and history budget — a verbatim copy of `cut()`, `JsonField` and
`fit_history()` from docker/speech-stack/server.py (same rules as the gateway's src/s2s/sentence-cutter.ts,
json-field.ts and history.ts), so the edge voices a reply in the same chunks as `/v1/s2s` and sends the LLM the same
history. tests/test_units.py checks the copy against server.py.
"""

import os
import re

FIRST_MIN_WORDS = int(os.environ.get("FIRST_MIN_WORDS", "3"))
MAX_CHUNK_CHARS = int(os.environ.get("MAX_CHUNK_CHARS", "160"))

SENTENCE_END = re.compile(r"[.!?…]+[\"'»”)\]]*(?=\s|$)")
CLAUSE_END = re.compile(r"[,;:—–](?=\s)")  # needs the following space, so "3,50" never cuts


ABBREVIATIONS = {"sr", "sra", "srta", "dr", "dra", "prof", "profa", "av", "etc", "ex", "nº", "n", "mr", "mrs", "st", "m", "mme"}
MIN_SENTENCE_WORDS = 2
CUT_EAGER = os.environ.get("CUT_EAGER", "0") == "1"


def cut(buffer: str, first: bool, final: bool) -> tuple[str | None, str]:
    """Next speakable chunk from the streamed text, or None to wait for more tokens.
    A sentence end cuts once the chunk has MIN_SENTENCE_WORDS words (a one-word "Amiga?" waits for the next sentence:
    tiny TTS calls cost a round trip and flatten the intonation) and is not an abbreviation ("Dr.", "Sra.").
    The FIRST chunk also cuts at a clause mark once it has FIRST_MIN_WORDS words, so the first audio does not wait for
    a long sentence. Anything longer than MAX_CHUNK_CHARS cuts at the last space."""
    for match in SENTENCE_END.finditer(buffer):
        if match.end() == len(buffer) and not final and not (CUT_EAGER and match.group()[-1] in "!?"):
            break  # "3." may still become "3.50": a mark at the end of the stream so far waits for the next token
        head = buffer[:match.end()]
        last_word = head[:match.start()].split()[-1:] or [""]
        if match.group().startswith(".") and last_word[0].lower().strip("(\"'«") in ABBREVIATIONS:
            continue
        if len(head.split()) >= MIN_SENTENCE_WORDS:
            return head.strip(), buffer[match.end():]
    if first:
        for clause in CLAUSE_END.finditer(buffer):
            head = buffer[:clause.end()]
            if len(head.split()) >= FIRST_MIN_WORDS:
                return head.strip(), buffer[clause.end():]
    if len(buffer) > MAX_CHUNK_CHARS and " " in buffer[:MAX_CHUNK_CHARS]:
        at = buffer[:MAX_CHUNK_CHARS].rindex(" ")
        return buffer[:at].strip(), buffer[at:]
    if final and buffer.strip():
        return buffer.strip(), ""
    return None, buffer


class JsonField:
    """Streams the value of one top-level string field out of a JSON answer arriving in chunks (same rules as the
    gateway's src/s2s/json-field.ts, itself from parle's createUtteranceExtractor): text before the root object and
    <think> blocks are skipped; returns (new_text, closed)."""
    ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f"}

    def __init__(self, key: str):
        self.key, self.phase, self.preamble, self.thinking = key, "seek", "", False
        self.depth, self.in_string, self.escape, self.unicode = 0, False, False, None
        self.reading_key, self.expect_key, self.key_text, self.value_of, self.capturing = False, False, "", None, False

    def push(self, chunk: str) -> tuple[str, bool]:
        text, closed = "", False
        for ch in chunk:
            if self.phase == "over":
                break
            if self.phase == "seek":
                self.preamble = (self.preamble + ch)[-64:]
                if not self.thinking and self.preamble.endswith("<think>"):
                    self.thinking = True
                elif self.thinking and self.preamble.endswith("</think>"):
                    self.thinking = False
                elif not self.thinking and ch == "{":
                    self.phase, self.depth, self.expect_key = "object", 1, True
                continue
            if self.in_string:
                if not self.escape and self.unicode is None and ch == '"':
                    self.in_string = False
                    if self.capturing:
                        self.capturing, closed, self.phase = False, True, "over"
                    elif self.reading_key:
                        self.reading_key, self.expect_key = False, False
                    continue
                value = self._char(ch)
                if value is None:
                    continue
                if self.capturing:
                    text += value
                elif self.reading_key:
                    self.key_text += value
                continue
            if ch == '"':
                self.in_string = True
                self.reading_key = self.depth == 1 and self.expect_key
                if self.reading_key:
                    self.key_text = ""
                self.capturing = self.depth == 1 and not self.reading_key and self.value_of == self.key
                continue
            if ch in "{[":
                self.depth += 1
            elif ch in "}]":
                self.depth -= 1
                if self.depth <= 0:
                    self.phase = "over"
            elif self.depth == 1 and ch == ",":
                self.expect_key, self.value_of = True, None
            elif self.depth == 1 and ch == ":":
                self.value_of = self.key_text
        if self.phase == "over" and not closed and not self.capturing:
            closed = True
        return text, closed

    def _char(self, ch: str):
        if self.unicode is not None:
            self.unicode += ch
            if len(self.unicode) < 4:
                return None
            code, self.unicode = self.unicode, None
            try:
                return chr(int(code, 16))
            except ValueError:
                return None
        if self.escape:
            self.escape = False
            if ch == "u":
                self.unicode = ""
                return None
            return self.ESCAPES.get(ch, ch)
        if ch == "\\":
            self.escape = True
            return None
        return ch


DEFAULT_SLOT_CTX = 2048
CONTEXT_MARGIN = 64
BYTES_PER_TOKEN = 3
MESSAGE_TOKENS = 8
DROP_PAIRS = 8


def estimate_tokens(text: str | None) -> int:
    return MESSAGE_TOKENS + -(-len(str(text).encode()) // BYTES_PER_TOKEN) if text else 0


def fit_history(system: str | None, history: list[dict], user: str, max_tokens: int, ctx: int, harder: bool = False) -> list[dict]:
    pairs: list[list[dict]] = []
    for message in history:
        if message.get("role") == "system":
            continue
        if message.get("role") == "user" or not pairs:
            pairs.append([])
        pairs[-1].append(message)
    pinned = sum(estimate_tokens(m.get("content")) for m in history if m.get("role") == "system")
    room = (ctx - max_tokens - CONTEXT_MARGIN - estimate_tokens(system) - estimate_tokens(user) - pinned) // (2 if harder else 1)
    sizes = [sum(estimate_tokens(m.get("content")) for m in pair) for pair in pairs]
    drop = 0
    while drop < len(pairs) and sum(sizes[drop:]) > room:
        drop += DROP_PAIRS
    kept = {id(m) for pair in pairs[drop:] for m in pair}
    return [m for m in history if m.get("role") == "system" or id(m) in kept]
