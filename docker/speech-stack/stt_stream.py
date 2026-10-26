"""
Streaming STT session for `/ws/audio-stream`: the socket carries raw Int16 PCM (16 kHz mono) and every decode answers
with text. Two output shapes:

- legacy (default): `{"text": "<the whole stream so far>"}` per decode, `"final": true` when the window commits — the
  full running text, not deltas, which is what the gateway's StreamingSTTRouter relays to the client;
- `segments` (query `segments=1`): one utterance at a time, so a session that runs for hours never resends its past —
    {"type": "partial", "utterance": N, "text": "...", "stable": "...", "end_ms": …}
    {"type": "final",   "utterance": N, "text": "...", "reason": "silence"|"max_length"|"flush", "start_ms", "end_ms",
     "audio_ms", "language", "language_probability", "avg_logprob", "no_speech_prob", "compression_ratio", "decode_ms"}
  `text` of a partial always starts with its `stable` part, and a stable word never changes in a later partial of the
  same utterance (LocalAgreement-2: the words two decodes in a row agree on; Macháček, Dabre & Bojar 2023, "Turning
  Whisper into Real-Time Transcription System", IJCNLP-AACL demo). The `final` is decoded fresh over the utterance's
  audio, exactly as the batch route would, so it may still differ from the last partial; after it the next utterance
  starts (`utterance` + 1). `*_ms` are on the stream's audio clock (samples received / 16).

Whisper is not a streaming model. A partial decodes only the audio since the previous partial, plus 2 s of
overlap, and the text is joined onto the line already showing — an 8 s sentence used to be decoded from scratch on
every chunk. The final still decodes the whole utterance once (cutting it scored 36.1% WER against 30.3%). The
utterance ends when the tail of the buffer has been
quieter than `silence_rms` for `silence_seconds` (the decode that saw it is the final: no extra GPU pass), or when the
window is full: then the audio is cut at its quietest 100 ms in the last 3 s (between two words, not inside one) and
only the head is decoded as the final; the rest opens the next window, so no audio is decoded twice and no word is
repeated across the cut. A window with no 100 ms frame above `silence_rms` is dropped without a decode (Whisper invents
"Obrigado." over silence).

`prompt` (vocabulary: slide terms, names) goes to faster-whisper as `initial_prompt` on every decode of the stream, the
same as the batch route's `prompt`; `configure()` changes it (or the language) for the next decodes.

    session = SttStream(batcher, "pt", prompt="Kubernetes, Grafana", segments=True)
    session.push(pcm_bytes)                 # on every binary frame (event loop)
    for msg in session.tick(): send(msg)    # from a periodic task, off the event loop (blocking decode)
    for msg in session.finish(): send(msg)  # on a flush frame
"""

import re
import threading

import numpy as np

print("ucast stt_stream: partials decode only the new audio", flush=True)

SAMPLE_RATE = 16000
FRAME = SAMPLE_RATE // 10
# A full window is cut at its quietest 100 ms within this many seconds of its end.
CUT_SEARCH_SECONDS = 3.0
# A dropped silent window keeps this much of its end: the onset of the next word.
PREROLL_SECONDS = 0.2
# Abuse bound only: faster-whisper itself keeps the last 223 tokens of the prompt, as on the batch route.
MAX_PROMPT_CHARS = 4000
FINAL_META = ("language", "language_probability", "avg_logprob", "no_speech_prob", "compression_ratio", "speech_ms",
              "decode_ms")
_WORD = re.compile(r"[\W_]+", re.UNICODE)


def clean_prompt(prompt) -> str | None:
    text = str(prompt or "").replace("\x00", " ").strip()
    return text[:MAX_PROMPT_CHARS] or None


def bare(word: str) -> str:
    """A word compared without case or punctuation: "Hoje," and "hoje" agree."""
    return _WORD.sub("", word).casefold()


# A partial repeats this much of the audio already shown, so the new words can be joined onto them.
PARTIAL_OVERLAP_SECONDS = 2.0


def join_tail(prev: str, new: str) -> str | None:
    """`new` was decoded from the end of `prev` plus what was said since. None when the overlap does not match."""
    prev_w, new_w = prev.split(), new.split()
    if not prev_w:
        return new
    if not new_w:
        return prev
    limit = min(12, len(prev_w), len(new_w))
    for k in range(limit, 0, -1):
        tail = [bare(w) for w in prev_w[-k:]]
        for skip in range(3):
            if skip + k > len(new_w):
                continue
            if tail == [bare(w) for w in new_w[skip:skip + k]]:
                rest = new_w[skip + k:]
                return prev if not rest else prev + " " + " ".join(rest)
    return None


def frame_rms(audio: np.ndarray) -> np.ndarray:
    whole = len(audio) // FRAME * FRAME
    if not whole:
        return np.sqrt(np.mean(audio * audio, keepdims=True)) if len(audio) else np.zeros(1)
    frames = audio[:whole].reshape(-1, FRAME)
    return np.sqrt(np.mean(frames * frames, axis=1))


class SttStream:
    def __init__(self, batcher, language: str | None = None, chunk_seconds: float = 1.0,
                 window_seconds: float = 20.0, silence_seconds: float = 0.9, silence_rms: float = 0.008,
                 prompt: str | None = None, segments: bool = False):
        self.batcher = batcher
        self.language = language[:2] if language else None
        self.prompt = clean_prompt(prompt)
        self.segments = segments
        self.chunk_samples = int(max(0.2, min(chunk_seconds, 5.0)) * SAMPLE_RATE)
        self.window_samples = int(max(5.0, min(window_seconds, 28.0)) * SAMPLE_RATE)
        self.silence_samples = int(max(0.3, min(silence_seconds, 3.0)) * SAMPLE_RATE)
        self.silence_rms = silence_rms
        self.audio = np.zeros(0, dtype=np.float32)
        self.undecoded = 0
        # Samples received before the start of `audio` (the audio clock of *_ms).
        self.consumed = 0
        self.committed = ""  # legacy: the whole stream's text so far
        self.last_emitted = ""
        # segments mode: the open utterance
        self.utterance = 0
        self.stable: list[str] = []
        self.previous: list[str] = []
        self.shown = ""
        self._partial_end = 0  # samples of this buffer already covered by a partial
        self._lock = threading.Lock()  # audio buffer (push runs on the event loop, decodes in a thread)
        self._decoding = threading.Lock()  # one decode at a time (tick and a flush's finish)

    # ── input ───────────────────────────────────────────────────────────────

    def push(self, pcm: bytes) -> None:
        """Append a binary frame of Int16 PCM; a trailing odd byte (not a full sample) is dropped."""
        if len(pcm) % 2:
            pcm = pcm[:-1]
        if not pcm:
            return
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        with self._lock:
            self.audio = np.concatenate([self.audio, samples])
            self.undecoded += len(samples)

    def configure(self, prompt=None, language=None, clear_prompt: bool = False) -> dict:
        """A `{"type": "config"}` frame: a new prompt and/or language for the next decodes (the open window included)."""
        if clear_prompt:
            self.prompt = None
        elif prompt is not None:
            self.prompt = clean_prompt(prompt)
        if language is not None:
            self.language = str(language)[:2] or None
        return {"type": "config", "language": self.language, "prompt_chars": len(self.prompt or "")}

    # ── helpers ─────────────────────────────────────────────────────────────

    def _ms(self, samples: int) -> int:
        return round((self.consumed + samples) * 1000 / SAMPLE_RATE)

    def _snapshot(self) -> tuple[np.ndarray, int]:
        with self._lock:
            return self.audio, len(self.audio)

    def _drop(self, upto: int, keep_tail: int = 0) -> None:
        """Forget the first `upto` samples of the buffer (but `keep_tail` of them); samples pushed meanwhile stay."""
        start = max(0, upto - keep_tail)
        with self._lock:
            self.audio = self.audio[start:]
            self.consumed += start
            self.undecoded = max(0, len(self.audio) - (upto - start))
        self._partial_end = 0

    def _quiet(self, audio: np.ndarray) -> bool:
        return len(audio) >= self.silence_samples and float(frame_rms(audio).max()) < self.silence_rms

    def _tail_silent(self, audio: np.ndarray) -> bool:
        """Energy VAD: the last `silence_seconds` are quieter than silence_rms of full-scale PCM."""
        if len(audio) < self.silence_samples or len(audio) < SAMPLE_RATE:
            return False
        tail = audio[-self.silence_samples:]
        return bool(np.sqrt(np.mean(tail * tail)) < self.silence_rms)

    def _cut_point(self, audio: np.ndarray) -> int:
        """Middle of the quietest 100 ms frame in the last CUT_SEARCH_SECONDS of a full window."""
        search_from = max(0, len(audio) - int(CUT_SEARCH_SECONDS * SAMPLE_RATE)) // FRAME * FRAME
        rms = frame_rms(audio[search_from:])
        quietest = int(np.argmin(rms)) if len(rms) else 0
        return min(len(audio), search_from + quietest * FRAME + FRAME // 2)

    def _error(self, error: BaseException) -> dict:
        return {"type": "error", "message": repr(error)[:200]} if self.segments else {"error": repr(error)[:200]}

    def _decode(self, audio: np.ndarray, partial: bool) -> dict:
        heard = self.batcher.transcribe(audio, self.language, prompt=self.prompt, partial=partial)
        return {**heard, "text": (heard.get("text") or "").strip()}

    # ── segments mode ───────────────────────────────────────────────────────

    def _partial(self, text: str, end: int) -> list[dict]:
        words = text.split()
        if self.stable:
            n = len(self.stable)
            if [bare(w) for w in words[:n]] == [bare(w) for w in self.stable]:
                rest = words[n:]
            else:
                # The decode reworded the stable part: continue after the last stable word if it is near its place.
                last = bare(self.stable[-1])
                near = [i for i in range(max(0, n - 3), min(len(words), n + 2)) if bare(words[i]) == last]
                rest = words[near[-1] + 1:] if near else words[n:]
            words = self.stable + rest
        agreed = 0
        for mine, before in zip(words, self.previous):
            if bare(mine) != bare(before):
                break
            agreed += 1
        if agreed > len(self.stable):
            self.stable = words[:agreed]
        self.previous = words
        shown = " ".join(words)
        if not shown or shown == self.shown:
            return []
        self.shown = shown
        return [{"type": "partial", "utterance": self.utterance, "text": shown, "stable": " ".join(self.stable),
                 "end_ms": self._ms(end)}]

    def _final(self, heard: dict | None, reason: str, end: int) -> list[dict]:
        text = heard["text"] if heard else self.shown
        msgs = []
        if text or self.shown:
            meta = {k: heard[k] for k in FINAL_META if heard and k in heard}
            msgs.append({"type": "final", "utterance": self.utterance, "text": text, "reason": reason,
                         "start_ms": self._ms(0), "end_ms": self._ms(end), "audio_ms": round(end * 1000 / SAMPLE_RATE), **meta})
            self.utterance += 1
        self.stable, self.previous, self.shown = [], [], ""
        return msgs

    # ── legacy mode ─────────────────────────────────────────────────────────

    def _legacy(self, heard_text: str, committed: bool) -> list[dict]:
        text = (self.committed + " " + heard_text).strip()
        if committed:
            self.committed = text
        if not text or text == self.last_emitted:
            return []
        self.last_emitted = text
        return [{"text": text, "final": True}] if committed else [{"text": text}]

    # ── decoding ────────────────────────────────────────────────────────────

    def tick(self) -> list[dict]:
        """Decode the open window once enough new audio arrived. Blocking — run it off the event loop."""
        with self._decoding:
            with self._lock:
                if self.undecoded < self.chunk_samples or not len(self.audio):
                    return []
            audio, n = self._snapshot()
            if self._quiet(audio):
                msgs = self._final(None, "silence", n) if self.segments and self.shown else []
                self._drop(n, keep_tail=int(PREROLL_SECONDS * SAMPLE_RATE))
                return msgs
            try:
                if n >= self.window_samples:
                    cut = self._cut_point(audio)
                    heard = self._decode(audio[:cut], partial=False)
                    msgs = self._final(heard, "max_length", cut) if self.segments else self._legacy(heard["text"], True)
                    self._drop(cut)
                    return msgs
                overlap = int(PARTIAL_OVERLAP_SECONDS * SAMPLE_RATE)
                tail_from = 0
                if self.segments and self.shown and self._partial_end > overlap and n > self._partial_end:
                    start = self._partial_end - overlap
                    if n - start <= self.window_samples:
                        tail_from = start
                view = audio[tail_from:] if tail_from else audio
                heard = self._decode(view, partial=True)
                if tail_from:
                    joined = join_tail(self.shown, heard["text"])
                    if joined is None:
                        self._partial_end = 0
                        with self._lock:
                            self.undecoded = max(0, len(self.audio) - n)
                        return []
                    heard = {**heard, "text": joined}
                self._partial_end = n
            except Exception as error:  # noqa: BLE001 — one bad decode must not kill the stream
                with self._lock:
                    self.undecoded = max(0, len(self.audio) - n)
                return [self._error(error)]
            if self._tail_silent(audio) and heard["text"]:
                msgs = self._final(heard, "silence", n) if self.segments else self._legacy(heard["text"], True)
                self._drop(n)
                return msgs
            with self._lock:
                self.undecoded = max(0, len(self.audio) - n)
            return self._partial(heard["text"], n) if self.segments else self._legacy(heard["text"], False)

    def finish(self) -> list[dict]:
        """Last decode of whatever is still buffered (a flush frame): the open utterance's final."""
        with self._decoding:
            audio, n = self._snapshot()
            msgs: list[dict] = []
            heard = None
            if n >= int(0.2 * SAMPLE_RATE) and (self.undecoded or self.shown) and not self._quiet(audio):
                try:
                    heard = self._decode(audio, partial=False)
                except Exception as error:  # noqa: BLE001
                    return [self._error(error)]
            if self.segments:
                msgs = self._final(heard, "flush", n)
                self._drop(n)
                return msgs
            self._drop(n)
            if heard:
                text = (self.committed + " " + heard["text"]).strip()
                self.committed = text
                if text != self.last_emitted:
                    self.last_emitted = text
                    msgs.append({"text": text})
            if self.last_emitted:
                msgs.append({"text": self.last_emitted, "final": True})
            return msgs
