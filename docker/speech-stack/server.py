"""
Speech-to-speech in one container: hear (faster-whisper large-v3, in this process), think (Qwen3.5-9B Q4 on llama.cpp,
127.0.0.1:8092) and speak (Qwen3-TTS 0.6B on vLLM-Omni, 127.0.0.1:8091), streamed end to end for the lowest time to
first audio:

    audio ──► STT ──► LLM tokens (stream) ──► sentence cutter ──► TTS per sentence (stream) ──► PCM frames out
                                                   │ first chunk cut early at a clause (≥ FIRST_MIN_WORDS words)
                                                   └ up to TTS_PARALLEL sentences synthesized ahead, played in order

POST /v1/s2s       multipart: `file` (audio, any ffmpeg/PyAV format) + `config` (JSON, see S2SConfig below).
                   Response `application/x-aigw-s2s`: frames of [1 byte kind][4 bytes big-endian length][payload]
                     kind "E" = JSON event (transcript, sentence, timing, done, error), kind "A" = raw PCM s16le mono
                     24 kHz. No base64 on the hot path. `?format=ndjson` gives JSON lines (audio as base64) for debugging.
POST /v1/audio/transcriptions   OpenAI-shaped STT (multipart `file`, `language`, `prompt`).
POST /v1/chat/completions       proxied to the LLM (streaming passes through).
POST /v1/audio/speech           proxied to the TTS (streaming passes through).
GET  /refs/<id>.wav             reference voices (from /files/voices.json, see load_voices).
GET  /health                    200 only when the three models answered a warm-up.
"""

import asyncio
import base64
import json
import os
import re
import struct
import subprocess
import time
from pathlib import Path

import httpx
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from faster_whisper import WhisperModel

from stt_batch import SttBatcher

TTS_URL = "http://127.0.0.1:8091"
LLM_URL = "http://127.0.0.1:8092"
TTS_MODEL = os.environ.get("TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base")
STT_MODEL = os.environ.get("STT_MODEL", "large-v3")
STT_BEAM = int(os.environ.get("STT_BEAM", "1"))
# Utterances arriving within STT_BATCH_WINDOW_MS share one GPU pass, up to STT_BATCH clips (stt_batch.py). L4: 4,
# L40S: 8 — the batch's encoder activations must fit next to the TTS and the LLM.
STT_BATCH = int(os.environ.get("STT_BATCH", "4"))
STT_BATCH_WINDOW_MS = int(os.environ.get("STT_BATCH_WINDOW_MS", "25"))
TTS_PARALLEL = int(os.environ.get("TTS_PARALLEL", "2"))
FIRST_MIN_WORDS = int(os.environ.get("FIRST_MIN_WORDS", "3"))
MAX_CHUNK_CHARS = int(os.environ.get("MAX_CHUNK_CHARS", "160"))
SAMPLE_RATE = 24000
REFS = Path("/srv/refs")
FILES = Path("/files")

# Full-precision Whisper large-v3 by default (float16 weights, not the int8 quantization): the student's accented
# speech is where an STT loses most, and the owner asked for the full model (2026-10-04). STT_COMPUTE=int8_float16 saves
# ~2 GB of GPU memory if a smaller card ever needs it.
STT_COMPUTE = os.environ.get("STT_COMPUTE", "float16")
stt = WhisperModel(STT_MODEL, device="cuda", compute_type=STT_COMPUTE, num_workers=1)
stt_batcher = SttBatcher(stt, max_batch=STT_BATCH, window_ms=STT_BATCH_WINDOW_MS, beam=STT_BEAM)
client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=5.0), limits=httpx.Limits(max_connections=64))
voices: dict[str, dict] = {}
ready = {"ok": False, "detail": "starting"}
app = FastAPI()


# ── Voices ───────────────────────────────────────────────────────────────────

def load_voices() -> None:
    """`/files/voices.json` = [{"id", "text", "files": [keys under /files], "lang"?, "gender"?}] → /srv/refs/<id>.wav
    (concatenated, mono 24 kHz). A voice that fails to convert is skipped, never the whole catalog."""
    REFS.mkdir(parents=True, exist_ok=True)
    manifest = FILES / "voices.json"
    if not manifest.exists():
        return
    for voice in json.loads(manifest.read_text()):
        try:
            sources = [str(FILES / key) for key in voice["files"]]
            inputs = sum((["-i", s] for s in sources), [])
            out = REFS / f"{voice['id']}.wav"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex",
                            f"concat=n={len(sources)}:v=0:a=1", "-ac", "1", "-ar", "24000", str(out)], check=True)
            voices[voice["id"]] = {**{k: voice[k] for k in ("lang", "gender", "label") if k in voice},
                                   "audio": f"http://127.0.0.1:8000/refs/{voice['id']}.wav", "text": voice["text"].strip()}
        except Exception as error:  # noqa: BLE001 — one bad voice must not kill the catalog
            print("voice", voice.get("id"), repr(error), flush=True)


# ── Hear ─────────────────────────────────────────────────────────────────────

def decode_16k(data: bytes) -> np.ndarray:
    """Any container/codec → mono float32 16 kHz via ffmpeg. faster-whisper 1.2.1 decodes with PyAV through an
    `open(metadata_errors=…)` argument that PyAV 19 removed (2026-10-04: every /v1/s2s failed with TypeError), so the
    audio never goes through PyAV here."""
    out = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
                         input=data, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


def transcribe_sync(data: bytes, language: str | None, prompt: str | None) -> dict:
    started = time.perf_counter()
    heard = stt_batcher.transcribe(decode_16k(data), language, prompt)
    return {**heard, "ms": round((time.perf_counter() - started) * 1000)}


# ── Think: stream tokens, cut sentences ──────────────────────────────────────

SENTENCE_END = re.compile(r"[.!?…]+[\"'»”)\]]*(?=\s|$)")
CLAUSE_END = re.compile(r"[,;:—–](?=\s)")  # needs the following space, so "3,50" never cuts


ABBREVIATIONS = {"sr", "sra", "srta", "dr", "dra", "prof", "profa", "av", "etc", "ex", "nº", "n", "mr", "mrs", "st", "m", "mme"}
MIN_SENTENCE_WORDS = 2


def cut(buffer: str, first: bool, final: bool) -> tuple[str | None, str]:
    """Next speakable chunk from the streamed text, or None to wait for more tokens.
    A sentence end cuts once the chunk has MIN_SENTENCE_WORDS words (a one-word "Amiga?" waits for the next sentence:
    tiny TTS calls cost a round trip and flatten the intonation) and is not an abbreviation ("Dr.", "Sra.").
    The FIRST chunk also cuts at a clause mark once it has FIRST_MIN_WORDS words, so the first audio does not wait for
    a long sentence. Anything longer than MAX_CHUNK_CHARS cuts at the last space."""
    for match in SENTENCE_END.finditer(buffer):
        if match.end() == len(buffer) and not final:
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


async def llm_stream(messages: list[dict], max_tokens: int, temperature: float, response_format: dict | None = None):
    body = {"model": "llm", "messages": messages, "stream": True, "max_tokens": max_tokens, "temperature": temperature,
            "chat_template_kwargs": {"enable_thinking": False}}
    if response_format:
        body["response_format"] = response_format
    async with client.stream("POST", f"{LLM_URL}/v1/chat/completions", json=body) as res:
        if res.status_code != 200:
            raise RuntimeError(f"llm http {res.status_code}: {(await res.aread())[:200]!r}")
        async for line in res.aiter_lines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            delta = json.loads(line[6:])["choices"][0].get("delta", {}).get("content")
            if delta:
                yield delta


# ── Speak ────────────────────────────────────────────────────────────────────

async def tts_stream(text: str, language: str, voice: dict, out: asyncio.Queue) -> None:
    """Raw PCM s16le 24 kHz chunks of one sentence into `out`, then None. vLLM-Omni streams the Code2Wav chunks as soon
    as they decode with `stream: true` + `stream_format: "audio"` (pcm/wav only)."""
    body = {"model": TTS_MODEL, "input": text, "task_type": "Base", "language": language, "ref_audio": voice["audio"],
            "ref_text": voice["text"], "response_format": "pcm", "stream": True, "stream_format": "audio"}
    try:
        async with client.stream("POST", f"{TTS_URL}/v1/audio/speech", json=body) as res:
            if res.status_code != 200:
                raise RuntimeError(f"tts http {res.status_code}: {(await res.aread())[:200]!r}")
            async for chunk in res.aiter_bytes():
                if chunk:
                    await out.put(chunk)
    finally:
        await out.put(None)


LANGUAGE = {"pt": "Portuguese", "fr": "French", "en": "English", "es": "Spanish"}


def frame(kind: bytes, payload: bytes) -> bytes:
    return kind + struct.pack(">I", len(payload)) + payload


@app.post("/v1/s2s")
async def s2s(request: Request, file: UploadFile = File(...), config: str = Form("{}")):
    """config: {"messages": [...history, OpenAI shape], "system": str, "language": "pt", "voice": id |
    {"audio": url-or-data-url, "text": transcript}, "max_tokens": 160, "temperature": 0.6, "stt_prompt": str}"""
    t0 = time.perf_counter()
    cfg = json.loads(config or "{}")
    audio = await file.read()
    lang = (cfg.get("language") or "pt")[:2]
    voice = cfg.get("voice")
    voice = voices.get(voice) if isinstance(voice, str) else voice
    if not voice or "audio" not in voice or "text" not in voice:
        raise HTTPException(400, "voice must be a known id or {audio, text}")
    ndjson = request.query_params.get("format") == "ndjson"
    ms = lambda: round((time.perf_counter() - t0) * 1000)  # noqa: E731

    def event(payload: dict) -> bytes:
        return (json.dumps(payload) + "\n").encode() if ndjson else frame(b"E", json.dumps(payload).encode())

    def pcm(chunk: bytes) -> bytes:
        return (json.dumps({"type": "audio", "pcm": base64.b64encode(chunk).decode()}) + "\n").encode() if ndjson \
            else frame(b"A", chunk)

    async def run():
        try:
            heard = await asyncio.to_thread(transcribe_sync, audio, lang, cfg.get("stt_prompt"))
            yield event({"type": "transcript", "text": heard["text"], "stt_ms": heard["ms"], "at_ms": ms()})
            messages = ([{"role": "system", "content": cfg["system"]}] if cfg.get("system") else []) \
                + list(cfg.get("messages") or []) + [{"role": "user", "content": heard["text"]}]
            gate = asyncio.Semaphore(TTS_PARALLEL)
            sentences: asyncio.Queue = asyncio.Queue()  # (text, audio queue) in speaking order, None at the end
            reply = []

            field = JsonField(cfg["speak_field"]) if cfg.get("speak_field") else None
            raw: list[str] = []

            async def think():
                buffer, first, first_token, field_closed = "", True, None, False
                async for delta in llm_stream(messages, int(cfg.get("max_tokens", 160)), float(cfg.get("temperature", 0.6)),
                                              cfg.get("response_format")):
                    if first_token is None:
                        first_token = ms()
                        await sentences.put(("__event__", {"type": "llm_first_token", "at_ms": first_token}))
                    raw.append(delta)
                    if field is not None:
                        if field_closed:
                            continue
                        delta, field_closed = field.push(delta)
                    buffer += delta
                    while True:
                        chunk, buffer = cut(buffer, first, False)
                        if not chunk:
                            break
                        first = False
                        await speak(chunk)
                chunk, _ = cut(buffer, first, True)
                if chunk:
                    await speak(chunk)
                await sentences.put(None)

            async def speak(text: str):
                reply.append(text)
                queue: asyncio.Queue = asyncio.Queue()

                async def synth():
                    async with gate:
                        await tts_stream(text, LANGUAGE.get(lang, "Portuguese"), voice, queue)
                asyncio.create_task(synth())
                await sentences.put((text, queue, ms()))

            thinker = asyncio.create_task(think())
            first_audio = None
            while True:
                item = await sentences.get()
                if item is None:
                    break
                if item[0] == "__event__":
                    yield event(item[1])
                    continue
                text, queue, cut_at = item
                yield event({"type": "sentence", "text": text, "cut_at_ms": cut_at})
                while (chunk := await queue.get()) is not None:
                    if first_audio is None:
                        first_audio = ms()
                        yield event({"type": "first_audio", "at_ms": first_audio})
                    yield pcm(chunk)
            await thinker
            yield event({"type": "done", "reply": " ".join(reply), "transcript": heard["text"], "stt_ms": heard["ms"],
                         "first_audio_ms": first_audio, "total_ms": ms(),
                         **({"reply_raw": "".join(raw)} if field is not None else {})})
        except Exception as error:  # noqa: BLE001 — the stream already started: report in-band
            yield event({"type": "error", "message": repr(error)[:300], "at_ms": ms()})

    return StreamingResponse(run(), media_type="application/x-ndjson" if ndjson else "application/x-aigw-s2s",
                             headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"})


# ── Single-stage endpoints ───────────────────────────────────────────────────

@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...), language: str = Form(""), prompt: str = Form("")):
    return await asyncio.to_thread(transcribe_sync, await file.read(), language, prompt)


async def proxy(request: Request, url: str):
    body = await request.body()
    upstream = await client.send(client.build_request("POST", url, content=body,
                                                      headers={"content-type": request.headers.get("content-type", "application/json")}),
                                 stream=True)

    async def chunks():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
    return StreamingResponse(chunks(), status_code=upstream.status_code,
                             media_type=upstream.headers.get("content-type"), headers={"X-Accel-Buffering": "no"})


@app.post("/v1/chat/completions")
async def chat(request: Request):
    return await proxy(request, f"{LLM_URL}/v1/chat/completions")


@app.post("/v1/audio/speech")
async def speech(request: Request):
    return await proxy(request, f"{TTS_URL}/v1/audio/speech")


@app.get("/refs/{name}")
async def refs(name: str):
    path = REFS / name
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.wav", name) or not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/wav")


@app.get("/v1/voices")
async def list_voices():
    return {"voices": [{"id": k, **{f: v[f] for f in v if f != "audio"}} for k, v in voices.items()]}


@app.get("/health")
async def health():
    return JSONResponse({**ready, "stt": stt_batcher.stats}, status_code=200 if ready["ok"] else 503)


# ── Warm-up: the first real request must not pay kernel loads ───────────────

async def warm() -> None:
    try:
        load_voices()
        silence = np.zeros(16000, dtype=np.float32)
        await asyncio.gather(*[asyncio.to_thread(stt_batcher.transcribe, silence, "pt") for _ in range(STT_BATCH)])
        async for _ in llm_stream([{"role": "user", "content": "Diga oi."}], 8, 0.0):
            pass
        voice = next(iter(voices.values()), None)
        if voice:
            for line in ("Olá, bom dia.", "Tudo bem? Então vamos lá."):
                queue: asyncio.Queue = asyncio.Queue()
                await tts_stream(line, "Portuguese", voice, queue)
        ready.update(ok=True, detail="warm", voices=len(voices))
    except Exception as error:  # noqa: BLE001
        ready.update(ok=False, detail=f"warm failed: {error!r}"[:300])


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(warm())
