"""
Streaming STT session for `/ws/audio-stream`: the socket carries raw Int16 PCM (16 kHz mono) and every decode answers
`{"text": "<the whole utterance so far>"}` — the full running text, not deltas, which is what the gateway's
StreamingSTTRouter relays to the client.

Whisper is not a streaming model, so the session keeps an open window of at most `window_seconds` of audio and
re-decodes it whenever `chunk_seconds` of new sound arrived. The text "commits" (and the window slides) when the tail
of the buffer has been quieter than `silence_rms` for `silence_seconds`, or when the window is full — so a long
stretch of speech never queues a 30 s decode behind real-time audio.

    session = SttStream(batcher, "pt")
    session.push(pcm_bytes)            # on every binary frame
    for msg in session.tick(): send(msg)   # from a periodic task
    for msg in session.finish(): send(msg) # when the client disconnects
"""

import numpy as np

SAMPLE_RATE = 16000
# Above this much buffered audio the window commits even without a silence — bounds the decode to `window_seconds`.
KEEP_ON_CUT_SECONDS = 1.0


class SttStream:
    def __init__(self, batcher, language: str | None = None, chunk_seconds: float = 1.0,
                 window_seconds: float = 20.0, silence_seconds: float = 0.9, silence_rms: float = 0.008):
        self.batcher = batcher
        self.language = language[:2] if language else None
        self.chunk_samples = int(max(0.2, min(chunk_seconds, 5.0)) * SAMPLE_RATE)
        self.window_samples = int(max(5.0, min(window_seconds, 28.0)) * SAMPLE_RATE)
        self.silence_samples = int(max(0.3, silence_seconds) * SAMPLE_RATE)
        self.silence_rms = silence_rms
        self.audio = np.zeros(0, dtype=np.float32)
        self.committed = ""
        self.undecoded = 0
        self.last_emitted = ""

    def push(self, pcm: bytes) -> None:
        """Append a binary frame of Int16 PCM; a trailing odd byte (not a full sample) is dropped."""
        if len(pcm) % 2:
            pcm = pcm[:-1]
        if not pcm:
            return
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        self.audio = np.concatenate([self.audio, samples])
        self.undecoded += len(samples)

    def _tail_silent(self) -> bool:
        """Energy VAD: the last `silence_seconds` are quieter than silence_rms of full-scale PCM."""
        if len(self.audio) < self.silence_samples or len(self.audio) < SAMPLE_RATE:
            return False
        tail = self.audio[-self.silence_samples:]
        return bool(np.sqrt(np.mean(tail * tail)) < self.silence_rms)

    def _commit(self, keep_samples: int) -> None:
        self.audio = self.audio[-keep_samples:] if keep_samples else np.zeros(0, dtype=np.float32)
        self.undecoded = min(self.undecoded, keep_samples)

    def _decode_text(self) -> str:
        heard = self.batcher.transcribe(self.audio, self.language)
        return (heard.get("text") or "").strip()

    def tick(self) -> list[dict]:
        """Decode the open window once enough new audio arrived. Blocking — run it off the event loop."""
        if self.undecoded < self.chunk_samples or not len(self.audio):
            return []
        try:
            heard_text = self._decode_text()
        except Exception as error:  # noqa: BLE001 — one bad decode must not kill the stream
            self.undecoded = 0
            return [{"error": repr(error)[:200]}]
        self.undecoded = 0
        text = (self.committed + " " + heard_text).strip()
        committed = False
        if self._tail_silent() and heard_text:
            self._commit(0)
            committed = True
        elif len(self.audio) >= self.window_samples:
            self._commit(int(KEEP_ON_CUT_SECONDS * SAMPLE_RATE))
            committed = True
        if committed:
            self.committed = text
        if not text or text == self.last_emitted:
            return []
        self.last_emitted = text
        return [{"text": text, "final": committed}] if committed else [{"text": text}]

    def finish(self) -> list[dict]:
        """Last decode of whatever is still buffered — the stream's final full text."""
        msgs = []
        if len(self.audio) >= int(0.2 * SAMPLE_RATE) and self.undecoded:
            try:
                text = (self.committed + " " + self._decode_text()).strip()
            except Exception as error:  # noqa: BLE001
                return [{"error": repr(error)[:200]}]
            self.committed = text
            if text != self.last_emitted:
                self.last_emitted = text
                msgs.append({"text": text})
        self.audio = np.zeros(0, dtype=np.float32)
        self.undecoded = 0
        if self.last_emitted:
            msgs.append({"text": self.last_emitted, "final": True})
        return msgs
