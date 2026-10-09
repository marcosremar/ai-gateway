"""
Where sessions live: the front process (WebSocket sessions, and WebRTC too when `RT_RTC_WORKERS=0`) and each WebRTC
worker process. A host owns its sessions' lifecycle — hard limits, teardown, telemetry `edge.session.open/close` —
and, for WebRTC, the aiortc peer connection with its audio track in and out.
"""

import asyncio
import fractions
import json
import time

import av
import numpy as np
from aiortc import MediaStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription, RTCIceServer
from aiortc.mediastreams import MediaStreamError
from aiortc.sdp import candidate_from_sdp

from .audio import Downsampler48to16, GapFill, upsample2
from .config import Settings
from .session import OUT_FRAME_BYTES, OUT_RATE, Session
from .telemetry import telemetry
from .upstream import Upstream


class OfferError(Exception):
    pass


class SessionGone(OfferError):
    pass


class OutTrack(MediaStreamTrack):
    """The NPC's voice as a WebRTC track: 20 ms frames of the session's AudioOut, silence when nothing is queued. Frames
    leave at 48 kHz, Opus's own rate: at 24 kHz aiortc's resampler keeps each frame until the next one comes (20 ms)."""

    kind = "audio"

    def __init__(self, session: Session):
        super().__init__()
        self.session = session
        self.samples = OUT_FRAME_BYTES // 2
        self.ts = 0
        self.t0: float | None = None
        self.previous = 0
        self.time_base = fractions.Fraction(1, 2 * OUT_RATE)

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        entered = time.monotonic()
        if self.t0 is None:
            self.t0 = entered
        else:
            self.session.out.sent(entered - self.t0 - self.ts / OUT_RATE)
            self.ts += self.samples
            wait = self.t0 + self.ts / OUT_RATE - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
        pcm = np.frombuffer(self.session.out.pull(OUT_FRAME_BYTES) or bytes(OUT_FRAME_BYTES), dtype=np.int16)
        frame = av.AudioFrame.from_ndarray(upsample2(pcm, self.previous).reshape(1, -1), format="s16", layout="mono")
        self.previous = int(pcm[-1])
        frame.sample_rate = 2 * OUT_RATE
        frame.pts = 2 * self.ts
        frame.time_base = self.time_base
        return frame


class SessionHost:
    def __init__(self, settings: Settings, upstream: Upstream):
        self.s = settings
        self.up = upstream
        self.sessions: dict[str, dict] = {}
        self.tasks: set[asyncio.Task] = set()

    def spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def register(self, session: Session, closer, **extra) -> None:
        self.sessions[session.sid] = {"session": session, "close": closer, "transport": session.transport, **extra}
        session.tel("edge.session.open", transport=session.transport, active=len(self.sessions))
        self.spawn(self.supervise(session))

    async def supervise(self, session: Session) -> None:
        """Hard limits: RT_MAX_SESSION_SECONDS (15 min) per session, RT_IDLE_SECONDS without any input."""
        while session.sid in self.sessions and not session.closed:
            await asyncio.sleep(1)
            now = time.monotonic()
            if now - session.started > self.s.max_session_seconds:
                session.emit({"type": "error", "code": "session_limit", "message": "session reached its maximum duration"})
                await asyncio.sleep(0.05)
                await self.end(session.sid, "session_limit")
            elif now - session.last_input > self.s.idle_seconds:
                session.emit({"type": "error", "code": "idle", "message": "no input"})
                await asyncio.sleep(0.05)
                await self.end(session.sid, "idle")

    async def end(self, sid: str, reason: str) -> bool:
        entry = self.sessions.pop(sid, None)
        if not entry:
            return False
        session: Session = entry["session"]
        await session.close()
        session.tel("edge.session.close", dur_ms=(time.monotonic() - session.started) * 1000, reason=reason,
                    transport=session.transport, turns=session.turns, active=len(self.sessions))
        try:
            await entry["close"](reason)
        except Exception:  # noqa: BLE001 — transport already gone
            pass
        return True

    async def close_all(self) -> None:
        for sid in list(self.sessions):
            await self.end(sid, "shutdown")
        for task in list(self.tasks):
            task.cancel()

    # ── WebRTC ───────────────────────────────────────────────────────────────

    async def offer(self, sdp: str, claims: dict, trace_id: str, ice_servers: list[dict] | None = None,
                    resume: bool = False) -> dict:
        sid = claims["sid"]
        entry = self.sessions.get(sid)
        if resume and (not entry or "pc" not in entry):
            raise SessionGone(sid)
        servers = [RTCIceServer(urls=x["urls"], username=x.get("username"), credential=x.get("credential")) for x in ice_servers or []]
        pc = RTCPeerConnection(RTCConfiguration(iceServers=servers))
        link = entry["link"] if resume else {"pc": None, "dc": None, "pending": [], "logged_pair": False}

        def emit(event: dict) -> None:
            text = json.dumps(event)
            dc = link["dc"]
            if dc is not None and dc.readyState == "open":
                dc.send(text)
            else:
                link["pending"].append(text)

        session = entry["session"] if resume else Session(sid, claims, self.s, self.up, emit, "webrtc", trace_id)

        @pc.on("datachannel")
        def on_datachannel(dc):
            if dc.label != "events" or link["pc"] is not pc:
                return
            link["dc"] = dc

            def flush():
                while link["pending"]:
                    dc.send(link["pending"].pop(0))
            if dc.readyState == "open":
                flush()
            dc.on("open", flush)

            @dc.on("message")
            def on_message(message):
                if isinstance(message, str):
                    try:
                        session.control(json.loads(message))
                    except ValueError:
                        emit({"type": "error", "code": "bad_message", "message": "not JSON"})

        @pc.on("track")
        def on_track(track):
            if track.kind == "audio":
                self.spawn(self.read_track(track, session))

        @pc.on("iceconnectionstatechange")
        def on_ice():
            session.tel("edge.ice.state", level="warn" if pc.iceConnectionState == "failed" else "info",
                        state=pc.iceConnectionState, dur_ms=(time.monotonic() - session.started) * 1000)
            if pc.iceConnectionState in ("connected", "completed") and link["pc"] is pc and not link["logged_pair"]:
                link["logged_pair"] = True
                session.tel("edge.ice.selected", **selected_pair(pc), edgeRelay=bool(servers))

        @pc.on("connectionstatechange")
        async def on_state():
            if pc.connectionState in ("failed", "closed") and link["pc"] is pc:
                await self.end(sid, f"pc_{pc.connectionState}")

        async def close(_reason: str) -> None:
            await link["pc"].close()

        try:
            await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
            if not any(t.kind == "audio" for t in pc.getTransceivers()):
                raise ValueError("the offer has no audio m-line")
            pc.addTrack(OutTrack(session))
            await pc.setLocalDescription(await pc.createAnswer())
        except Exception as error:  # noqa: BLE001
            await pc.close()
            raise OfferError(f"offer rejected: {error!r}"[:300]) from error
        previous = link["pc"]
        link.update(pc=pc, dc=None, logged_pair=False)
        if resume:
            entry["pc"] = pc
            await previous.close()
            session.tel("edge.session.reoffer", dur_ms=(time.monotonic() - session.started) * 1000)
        else:
            self.register(session, close, pc=pc, link=link)
            emit({"type": "ready", "sessionId": sid, "transport": "webrtc", "traceId": trace_id})
        return {"sdp": pc.localDescription.sdp, "type": "answer", "sessionId": sid}

    async def read_track(self, track, session: Session) -> None:
        down = Downsampler48to16()
        gaps = GapFill()
        resampler = None
        try:
            while not session.closed:
                frame = await track.recv()
                if frame.sample_rate == 48000 and frame.format.name == "s16":
                    channels = len(frame.layout.channels)
                    missing = gaps.missing(frame.pts, frame.samples)
                    if missing:
                        session.lost_ms += missing // 48
                        session.feed(down.push(np.zeros(missing * channels, dtype=np.int16), channels))
                    session.feed(down.push(frame.to_ndarray(), channels))
                    continue
                resampler = resampler or av.AudioResampler(format="s16", layout="mono", rate=16000)
                for out in resampler.resample(frame):
                    session.feed(out.to_ndarray().tobytes())
        except (MediaStreamError, asyncio.CancelledError):
            pass

    async def add_ice(self, sid: str, raw) -> bool:
        entry = self.sessions.get(sid)
        if not entry or "pc" not in entry:
            return False
        if isinstance(raw, dict):
            line, mid, index = raw.get("candidate", ""), raw.get("sdpMid"), raw.get("sdpMLineIndex")
        else:
            line, mid, index = raw or "", None, 0
        if not line:  # end of candidates
            await entry["pc"].addIceCandidate(None)
            return True
        candidate = candidate_from_sdp(line.split(":", 1)[1] if line.startswith("candidate:") else line)
        candidate.sdpMid, candidate.sdpMLineIndex = mid if mid is not None else "0", index if index is not None else 0
        await entry["pc"].addIceCandidate(candidate)
        return True


def load_sample() -> dict:
    """Process CPU % since the previous call and RSS MB (from /proc; no psutil in the image)."""
    import os  # noqa: PLC0415
    now, cpu = time.monotonic(), sum(os.times()[:2])
    prev = getattr(load_sample, "prev", None)
    load_sample.prev = (now, cpu)
    pct = round((cpu - prev[1]) / (now - prev[0]) * 100, 1) if prev and now > prev[0] else None
    try:
        with open("/proc/self/statm") as f:
            rss = int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 2**20
    except OSError:
        rss = None
    return {"cpuPct": pct, "rssMb": round(rss) if rss else None}


async def load_loop(label: str, active) -> None:
    """`edge.load` every 30 s: active sessions, CPU % and RSS of this process."""
    load_sample()
    while True:
        await asyncio.sleep(30)
        telemetry.emit("edge.load", process=label, active=active(), **load_sample())


def selected_pair(pc) -> dict:
    """Which ICE pair carries the media: host↔host is the direct path, a `relay` side went through TURN."""
    try:
        for transceiver in pc.getTransceivers():
            conn = transceiver.receiver.transport.transport._connection
            for pair in conn._nominated.values():
                return {"local": pair.local_candidate.type, "remote": pair.remote_candidate.type,
                        "protocol": pair.local_candidate.transport}
    except Exception:  # noqa: BLE001 — aiortc internals: the log line is best effort
        pass
    return {"local": None, "remote": None, "protocol": None}
