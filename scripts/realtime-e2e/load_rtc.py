import asyncio
import json
import os
import sys
import time
from pathlib import Path

import aiohttp
import numpy as np
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "docker/aigw-edge/tests"))
from clients import MicTrack  # noqa: E402
from aigw_edge import audio  # noqa: E402

audio.install()

CLIP = Path(sys.argv[1]).read_bytes()
GATHER_S, OFFER_S, CONNECT_S = float(os.environ.get("RTC_GATHER_S", 2)), 3, float(os.environ.get("RTC_CONNECT_S", 3))
KEEP = ("type", "state", "final", "code", "empty", "filtered", "interrupted", "error", "ttfa_ms", "stt_ms", "llm_ttft_ms", "tts_ttfb_ms", "tts_retries",
        "first_sound_ms", "first_sound_from_speech_ms", "ttfa_from_speech_ms", "deadline_missed", "opener",
        "out_first_pull_ms", "rtp_first_sent_ms", "rtp_late_p50_ms", "rtp_late_p95_ms", "rtp_late_max_ms", "uplink_lost_ms", "uplink_recovered_ms", "uplink_fec_pct", "uplink_red_pct")
SKIP = ("reply_delta", "pong")
peers: dict = {}


def out(**msg) -> None:
    print(json.dumps({"t": time.time() * 1000, **msg}), flush=True)


def slim(event: dict) -> dict:
    return {**{k: event[k] for k in KEEP if k in event}, "chars": len(event.get("text") or "")}


def ice_servers(raw: list, turn: str) -> list:
    servers = []
    for s in raw or []:
        urls = [s["urls"]] if isinstance(s["urls"], str) else s["urls"]
        urls = [u for u in urls if not u.startswith("turn") or f"transport={turn}" in u]
        if urls:
            servers.append(RTCIceServer(urls=urls, username=s.get("username"), credential=s.get("credential")))
    return servers


class Mic(MicTrack):
    def __init__(self, on_end):
        super().__init__()
        self.on_end = on_end

    async def recv(self):
        frame = await super().recv()
        if self.speech_end_at is not None:
            self.speech_end_at = None
            self.on_end()
        return frame


class Peer:
    def __init__(self, pid: int):
        self.id = pid
        self.mic = Mic(lambda: out(id=pid, ev="speech_end"))
        self.first = self.last = None
        self.loud = 0
        self.tasks: list = []
        self.pc = None

    def on_message(self, data) -> None:
        event = json.loads(data)
        if event.get("type") in SKIP or (event.get("type") == "transcript" and not event.get("final")):
            return
        out(id=self.id, ev="event", event=slim(event))

    async def open(self, m: dict, http: aiohttp.ClientSession) -> None:
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers(m.get("iceServers"), m["turn"])))
        dc = self.pc.createDataChannel("events")
        dc.on("message", self.on_message)
        dc.on("close", lambda: out(id=self.id, ev="lost", reason="data channel closed"))
        self.pc.addTrack(self.mic)
        self.pc.on("track", lambda track: self.tasks.append(asyncio.ensure_future(self.listen(track))))
        self.pc.on("connectionstatechange", lambda: self.pc.connectionState == "failed" and out(id=self.id, ev="lost", reason="connection failed"))
        stage = "gather"
        try:
            await asyncio.wait_for(self.pc.setLocalDescription(await self.pc.createOffer()), GATHER_S)
            stage = "offer"
            async with http.post(m["offerUrl"], json={"sdp": self.pc.localDescription.sdp, "type": "offer", **({"cfg": m["cfg"]} if m.get("cfg") else {})},
                                 headers={"Authorization": f"Bearer {m['token']}"}, timeout=aiohttp.ClientTimeout(total=OFFER_S)) as r:
                body = await r.json(content_type=None)
                if r.status != 200 or not (body or {}).get("sdp"):
                    raise RuntimeError(f"HTTP {r.status} {((body or {}).get('error') or {}).get('code', '')}")
            stage = "connect"
            await self.pc.setRemoteDescription(RTCSessionDescription(sdp=body["sdp"], type="answer"))
            await asyncio.wait_for(self.opened(dc), CONNECT_S)
        except Exception as error:  # noqa: BLE001
            await self.close()
            out(id=self.id, ev="failed", stage=stage, error=(str(error) or type(error).__name__)[:120])
            return
        out(id=self.id, ev="connected", pair=self.pair())

    async def opened(self, dc) -> None:
        while dc.readyState != "open":
            await asyncio.sleep(0.02)

    def pair(self):
        try:
            p = self.pc.sctp.transport.transport._connection._nominated[1]
            return {"local": p.local_candidate.type, "remote": p.remote_candidate.type}
        except Exception:  # noqa: BLE001
            return None

    async def listen(self, track) -> None:
        try:
            while True:
                frame = await track.recv()
                pcm = frame.to_ndarray().astype(np.float32) / 32768.0
                if float(np.sqrt(np.mean(pcm * pcm))) > 0.02:
                    self.last = time.time() * 1000
                    self.loud += 1
                    if self.first is None:
                        self.first = self.last
                        out(id=self.id, ev="loud")
        except (MediaStreamError, asyncio.CancelledError):
            pass

    def say(self) -> None:
        self.first = self.last = None
        self.loud = 0
        self.mic.pending += CLIP
        self.mic.mark = len(self.mic.pending)

    async def close(self) -> None:
        for task in self.tasks:
            task.cancel()
        if self.pc:
            await self.pc.close()


async def main() -> None:
    loop = asyncio.get_running_loop()
    async with aiohttp.ClientSession() as http:
        while line := await loop.run_in_executor(None, sys.stdin.readline):
            m = json.loads(line)
            op, pid = m["op"], m["id"]
            if op == "open":
                peers[pid] = Peer(pid)
                asyncio.ensure_future(peers[pid].open(m, http))
            elif pid not in peers:
                continue
            elif op == "say":
                peers[pid].say()
            elif op == "audio":
                p = peers[pid]
                out(id=pid, ev="audio", first=p.first, last=p.last, loud=p.loud)
            elif op == "close":
                await peers.pop(pid).close()
    for p in peers.values():
        await p.close()


asyncio.run(main())
