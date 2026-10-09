"""Test clients of the edge: a WebSocket learner and a WebRTC (aiortc) learner, plus token minting like the gateway."""

import asyncio
import base64
import fractions
import json
import math
import random
import time
import uuid

import aiohttp
import av
from aioice.ice import StunProtocol
import numpy as np
from aiortc import MediaStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from aiortc import codecs, rtcrtpsender, rtcsctptransport
from aiortc.codecs.opus import OpusEncoder
from aiortc.rtp import is_rtcp

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aigw_edge import audio  # noqa: E402
from aigw_edge.config import derive_key  # noqa: E402
from aigw_edge.token import sign  # noqa: E402

REPLICA_TOKEN = "test-replica-token-0123456789abcdef"
KEY = derive_key(REPLICA_TOKEN)
FRAME = 320  # 20 ms at 16 kHz
DEFAULT_CFG = {"system": "Você é o padeiro.", "messages": [], "voice": "br-m-08", "language": "pt", "max_tokens": 80}


audio.install()
aiortc_encoder = rtcrtpsender.get_encoder


def red_payload(primary: bytes, previous: bytes | None, offset: int, payload_type: int) -> bytes:
    if not previous or len(previous) > 0x3FF or not 0 < offset < 1 << 14:
        return bytes([payload_type]) + primary
    return bytes([0x80 | payload_type]) + (offset << 10 | len(previous)).to_bytes(3, "big") + bytes([payload_type]) + previous + primary


class RedEncoder:
    def __init__(self, opus, payload_type: int):
        self.opus, self.payload_type = opus, payload_type
        self.previous: tuple[bytes, int] | None = None

    def encode(self, frame, force_keyframe: bool = False):
        payloads, timestamp = self.opus.encode(frame, force_keyframe)
        if len(payloads) != 1:
            return payloads, timestamp
        before, at = self.previous or (None, 0)
        self.previous = (payloads[0], timestamp)
        return [red_payload(payloads[0], before, timestamp - at, self.payload_type)], timestamp


def browser_like_encoder(codec):
    if audio.is_red(codec):
        opus = codecs.CODECS["audio"][0]
        return RedEncoder(browser_like_encoder(opus), opus.payloadType)
    encoder = aiortc_encoder(codec)
    if isinstance(encoder, OpusEncoder):
        encoder.codec.bit_rate = 32000
        encoder.codec.options = {"application": "voip", "fec": "1", "packet_loss": "10"}
    return encoder


rtcrtpsender.get_encoder = browser_like_encoder


rtcsctptransport.SCTP_RTO_INITIAL, rtcsctptransport.SCTP_RTO_MIN = 0.5, 0.4
NETWORK = {"loss": 0.0, "delay": 0.0, "rng": random.Random(11)}


def shape_network(loss: float = 0.0, delay_s: float = 0.0) -> None:
    NETWORK.update(loss=loss, delay=delay_s)


def shaped(call):
    def through(*args) -> None:
        if NETWORK["rng"].random() < NETWORK["loss"]:
            return
        if NETWORK["delay"]:
            asyncio.get_running_loop().call_later(NETWORK["delay"], call, *args)
        else:
            call(*args)
    return through


ice_made, ice_received = StunProtocol.connection_made, StunProtocol.datagram_received


def ice_connection_made(self, transport) -> None:
    ice_made(self, transport)
    transport.sendto = shaped(transport.sendto)


StunProtocol.connection_made = ice_connection_made
StunProtocol.datagram_received = lambda self, data, addr: shaped(ice_received)(self, data, addr)


def mint(cfg: dict | None = None, rep: str = "fr-par-2:replica-1", dep: str = "parle-speech", ttl: int = 600,
         iat_shift: int = 0, key: bytes = KEY, sid: str | None = None) -> str:
    now = int(time.time()) + iat_shift
    cfg_b64 = base64.urlsafe_b64encode(json.dumps(cfg if cfg is not None else DEFAULT_CFG).encode()).rstrip(b"=").decode()
    return sign({"sid": sid or uuid.uuid4().hex, "app": "parle", "dep": dep, "rep": rep, "cfg": cfg_b64,
                 "iat": now, "exp": now + ttl}, key)


def speech(seconds: float = 1.2, freq: float = 210.0) -> bytes:
    """A loud voiced-like tone (fundamental + harmonics) at 16 kHz: what the energy VAD sees as a learner speaking."""
    t = np.arange(int(seconds * 16000)) / 16000
    wave = 0.25 * np.sin(2 * math.pi * freq * t) + 0.1 * np.sin(2 * math.pi * 2 * freq * t) + 0.05 * np.sin(2 * math.pi * 3 * freq * t)
    return (wave * 32767).astype(np.int16).tobytes()


def silence(seconds: float) -> bytes:
    return bytes(int(seconds * 16000) * 2)


class Events:
    def __init__(self):
        self.items: list[tuple[float, dict]] = []
        self.cond = asyncio.Condition()

    async def add(self, event: dict) -> None:
        async with self.cond:
            self.items.append((time.monotonic(), event))
            self.cond.notify_all()

    def types(self) -> list[str]:
        return [e["type"] for _, e in self.items]

    def of(self, kind: str) -> list[dict]:
        return [e for _, e in self.items if e["type"] == kind]

    async def wait(self, kind: str, timeout: float = 10.0, after: int = 0) -> dict:
        async def has():
            for _, e in self.items[after:]:
                if e["type"] == kind:
                    return e
            return None

        async with self.cond:
            found = await has()
            deadline = time.monotonic() + timeout
            while found is None:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError(f"no {kind!r} event in {timeout}s; got {self.types()}")
                try:
                    await asyncio.wait_for(self.cond.wait(), left)
                except asyncio.TimeoutError:
                    pass
                found = await has()
            return found


class WsLearner:
    def __init__(self, base: str):
        self.base = base
        self.events = Events()
        self.audio_bytes = 0
        self.first_audio_at: float | None = None
        self.speech_end_at: float | None = None
        self.close_code = None
        self.mic = asyncio.Queue()
        self.tasks: list[asyncio.Task] = []

    async def connect(self, token: str) -> "WsLearner":
        self.http = aiohttp.ClientSession()
        self.ws = await self.http.ws_connect(f"{self.base}/__aigw/rt/ws?token={token}")
        self.tasks.append(asyncio.create_task(self._read()))
        self.tasks.append(asyncio.create_task(self._mic()))
        return self

    async def _read(self) -> None:
        async for msg in self.ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                await self.events.add(json.loads(msg.data))
            elif msg.type == aiohttp.WSMsgType.BINARY and msg.data[:1] == b"\x01":
                if self.first_audio_at is None:
                    self.first_audio_at = time.monotonic()
                self.audio_bytes += len(msg.data) - 1
        self.close_code = self.ws.close_code
        await self.events.add({"type": "__closed", "code": self.ws.close_code})

    async def _mic(self) -> None:
        """A live microphone: 20 ms frames at real time, silence when the learner is not talking."""
        t0, n = time.monotonic(), 0
        pending = b""
        while not self.ws.closed:
            if len(pending) < FRAME * 2 and not self.mic.empty():
                chunk, mark_end = self.mic.get_nowait()
                pending += chunk
                if mark_end:
                    self.mark = len(pending)
            frame, pending = (pending[:FRAME * 2], pending[FRAME * 2:]) if pending else (silence(0.02), b"")
            if getattr(self, "mark", None) is not None:
                self.mark -= FRAME * 2
                if self.mark <= 0:
                    self.speech_end_at, self.mark = time.monotonic(), None
            try:
                await self.ws.send_bytes(b"\x01" + frame)
            except Exception:  # noqa: BLE001
                return
            n += 1
            await asyncio.sleep(max(0, t0 + n * 0.02 - time.monotonic()))

    def say(self, seconds: float = 1.2) -> None:
        self.mic.put_nowait((speech(seconds), True))

    async def send(self, msg: dict) -> None:
        await self.ws.send_str(json.dumps(msg))

    async def close(self) -> None:
        for task in self.tasks:
            task.cancel()
        if not self.ws.closed:
            await self.ws.close()
        await self.http.close()


class MicTrack(MediaStreamTrack):
    kind = "audio"

    def __init__(self):
        super().__init__()
        self.pending = b""
        self.mark: int | None = None
        self.speech_end_at: float | None = None
        self.ts = 0
        self.t0: float | None = None

    def say(self, seconds: float = 1.2) -> None:
        self.pending += speech(seconds)
        self.mark = len(self.pending)

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        if self.t0 is None:
            self.t0 = time.monotonic()
        else:
            self.ts += FRAME
            await asyncio.sleep(max(0, self.t0 + self.ts / 16000 - time.monotonic()))
        if self.pending:
            pcm, self.pending = self.pending[:FRAME * 2], self.pending[FRAME * 2:]
            pcm += bytes(FRAME * 2 - len(pcm))
            if self.mark is not None:
                self.mark -= FRAME * 2
                if self.mark <= 0:
                    self.speech_end_at, self.mark = time.monotonic(), None
        else:
            pcm = bytes(FRAME * 2)
        frame = av.AudioFrame.from_ndarray(np.frombuffer(pcm, dtype=np.int16).reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate, frame.pts, frame.time_base = 16000, self.ts, fractions.Fraction(1, 16000)
        return frame


class RtcLearner:
    def __init__(self, base: str):
        self.base = base
        self.events = Events()
        self.mic = MicTrack()
        self.loud_frames = 0
        self.first_audio_at: float | None = None
        self.tasks: list[asyncio.Task] = []

    async def connect(self, token: str, standby: bool = False, red: bool = False) -> "RtcLearner":
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.dc = self.pc.createDataChannel("events")
        self.dc.on("message", lambda m: asyncio.ensure_future(self.events.add(json.loads(m))))
        if standby:
            self.sender = self.pc.addTransceiver("audio", direction="sendrecv").sender
        else:
            self.pc.addTrack(self.mic)
        if red:
            offered = codecs.get_capabilities("audio").codecs
            self.pc.getTransceivers()[0].setCodecPreferences(sorted(offered, key=lambda codec: not audio.is_red(codec)))

        @self.pc.on("track")
        def on_track(track):
            self.tasks.append(asyncio.create_task(self._listen(track)))

        await self.pc.setLocalDescription(await self.pc.createOffer())
        async with aiohttp.ClientSession() as http:
            async with http.post(f"{self.base}/__aigw/rt/offer", json={"sdp": self.pc.localDescription.sdp, "type": "offer",
                                                                       "token": token}) as r:
                self.status = r.status
                self.answer = await r.json()
        if self.status != 200:
            return self
        self.session_id = self.answer["sessionId"]
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=self.answer["sdp"], type="answer"))
        return self

    async def _listen(self, track) -> None:
        try:
            while True:
                frame = await track.recv()
                pcm = frame.to_ndarray().astype(np.float32) / 32768.0
                if float(np.sqrt(np.mean(pcm * pcm))) > 0.02:
                    self.loud_frames += 1
                    if self.first_audio_at is None:
                        self.first_audio_at = time.monotonic()
        except (MediaStreamError, asyncio.CancelledError):
            pass

    def impair(self, loss: float, jitter_s: float, seed: int = 7) -> None:
        rng, loop, dtls = random.Random(seed), asyncio.get_running_loop(), self.pc.getSenders()[0].transport
        send, handle = dtls._send_rtp, dtls._handle_rtp_data
        release = {"up": 0.0, "down": 0.0}

        def through(way: str, call, *args) -> None:
            if rng.random() < loss:
                return
            release[way] = max(release[way] + 1e-4, loop.time() + rng.random() * jitter_s)
            loop.call_at(release[way], lambda: asyncio.ensure_future(call(*args)))

        async def send_rtp(data: bytes) -> None:
            if is_rtcp(data):
                await send(data)
            else:
                through("up", send, data)

        async def handle_rtp(data: bytes, arrival_time_ms: int) -> None:
            through("down", handle, data, arrival_time_ms)

        dtls._send_rtp, dtls._handle_rtp_data = send_rtp, handle_rtp

    def activate(self) -> None:
        self.sender.replaceTrack(self.mic)

    async def send(self, msg: dict) -> None:
        self.dc.send(json.dumps(msg))

    async def close(self) -> None:
        for task in self.tasks:
            task.cancel()
        await self.pc.close()
