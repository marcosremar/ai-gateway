"""
aigw-edge — the realtime front of a GPU replica (docs/realtime-edge.md). Every route sits behind the replica's
token-gated nginx (`X-Aigw-Token`, cloud-init.ts) and is called by the gateway; the browser only ever reaches this
process through WebRTC media (UDP `RT_UDP_PORTS`) or through the gateway's WebSocket relay.

    POST   /__aigw/rt/offer          {sdp, type: "offer", token} → {sdp, type: "answer", sessionId}
    POST   /__aigw/rt/ice            {sessionId, candidate}       (trickle is optional: the answer carries all candidates)
    GET    /__aigw/rt/status         {active, max, available, transports, udpPorts, ready, byTransport, workers}
    DELETE /__aigw/rt/session/{id}
    GET    /__aigw/rt/ws?token=…     WebSocket: JSON events/control as text, audio as binary [0x01][PCM16 LE mono]
                                     (16 kHz up, 24 kHz down, 20 ms frames)
    `traceparent` (W3C) is read from the request header (or the offer body / WS query) and kept for the session.

Process model: aiortc does the RTP/SRTP/RTCP work of every packet in Python on one event loop (~7–9 % of a core per
WebRTC session, measured), so WebRTC sessions run in `RT_RTC_WORKERS` worker processes (default
ceil(RT_MAX_SESSIONS / RT_SESSIONS_PER_WORKER)), each with its own slice of the UDP range, behind this front, which does
admission (token, capacity), the WebSocket sessions (~2 % of a core each) and the status. RT_RTC_WORKERS=0 keeps
everything in this one process.
"""

import asyncio
import json
import multiprocessing as mp
import secrets
import time
from dataclasses import replace

import aiohttp
from aiohttp import web

from . import audio, ice
from .config import Settings
from .host import OfferError, SessionHost, load_loop
from .session import OUT_FRAME_BYTES, Session
from .telemetry import new_trace_id, telemetry, trace_id_from
from .token import TokenError, TokenVerifier
from .upstream import Upstream

AUDIO_TAG = 0x01
WS_LEAD_SECONDS = 0.2  # how far ahead of real time WS audio may run (the client's jitter buffer)
INTERNAL_HEADER = "X-Edge-Internal"


def error_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


def worker_ranges(lo: int, hi: int, n: int) -> list[tuple[int, int]]:
    size = (hi - lo + 1) // n
    if size < 2:
        raise ValueError(f"RT_UDP_PORTS {lo}-{hi} is too small for {n} workers")
    return [(lo + i * size, lo + (i + 1) * size - 1 if i < n - 1 else hi) for i in range(n)]


# ── WebRTC worker process ────────────────────────────────────────────────────

def worker_main(settings: Settings, index: int, secret: str) -> None:
    ice.install(settings)
    audio.install()
    up = Upstream(settings)
    host = SessionHost(settings, up)

    def internal(handler):
        async def wrapped(req: web.Request):
            if req.headers.get(INTERNAL_HEADER) != secret:
                return web.json_response(error_body("forbidden", "internal route"), status=403)
            return await handler(req)
        return wrapped

    async def offer(req):
        body = await req.json()
        try:
            return web.json_response(await host.offer(body["sdp"], body["claims"], body["traceId"]))
        except OfferError as error:
            return web.json_response(error_body("bad_request", str(error)), status=400)

    async def add_ice(req):
        body = await req.json()
        ok = await host.add_ice(body["sessionId"], body.get("candidate"))
        return web.json_response({"ok": ok}, status=200 if ok else 404)

    async def delete(req):
        ok = await host.end(req.match_info["sid"], "deleted")
        return web.json_response({"deleted": ok}, status=200 if ok else 404)

    async def sessions(_req):
        return web.json_response({"sids": list(host.sessions)})

    async def startup(_app):
        await up.start()
        up.ready = True  # the front gates admission on the models' health
        host.spawn(load_loop(f"rtc-worker-{index}", lambda: len(host.sessions)))

    async def cleanup(_app):
        await host.close_all()
        await up.close()

    app = web.Application(client_max_size=1 << 20)
    app.router.add_post("/__edge/offer", internal(offer))
    app.router.add_post("/__edge/ice", internal(add_ice))
    app.router.add_delete("/__edge/session/{sid}", internal(delete))
    app.router.add_get("/__edge/sessions", internal(sessions))
    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
    web.run_app(app, host="127.0.0.1", port=settings.port + 1 + index, access_log=None, print=None)


# ── front ────────────────────────────────────────────────────────────────────

class Edge:
    def __init__(self, settings: Settings):
        self.s = settings
        self.verifier = TokenVerifier(settings.key, settings.replica_id, settings.deployment)
        self.up = Upstream(settings)
        self.host = SessionHost(settings, self.up)
        n = settings.rtc_workers
        self.secret = secrets.token_hex(16)
        self.worker_settings = [replace(settings, udp_ports=r) for r in worker_ranges(*settings.udp_ports, n)] if n else []
        self.workers: list = [None] * n
        self.routes: dict[str, dict] = {}  # WebRTC sid → {worker, at}
        self.http: aiohttp.ClientSession | None = None

    # ── admission ────────────────────────────────────────────────────────────

    def active(self) -> int:
        return len(self.host.sessions) + len(self.routes)

    def admit(self, token: str | None, trace_id: str) -> tuple[dict | None, tuple[int, str, str] | None]:
        """(claims, None) or (None, (http status, error code, message)). Capacity is checked before the token is
        consumed, so a learner refused here can still use the same token on another replica."""
        if not token:
            return None, (401, "unauthorized", "token missing")
        try:
            self.verifier.verify(token, consume=False)
        except TokenError as error:
            telemetry.emit("edge.token.reject", trace_id=trace_id, level="warn", reason=error.reason)
            return None, (401, "unauthorized", f"token rejected: {error.reason}")
        if self.active() >= self.s.max_sessions:
            telemetry.emit("edge.capacity.reject", trace_id=trace_id, level="warn", active=self.active(), max=self.s.max_sessions)
            return None, (503, "capacity", f"replica full ({self.active()}/{self.s.max_sessions} sessions)")
        if not self.up.ready:
            telemetry.emit("edge.capacity.reject", trace_id=trace_id, level="warn", active=self.active(),
                           max=self.s.max_sessions, reason="warming")
            return None, (503, "warming", "models not ready yet")
        try:
            return self.verifier.verify(token), None
        except TokenError as error:
            return None, (401, "unauthorized", f"token rejected: {error.reason}")

    # ── HTTP routes ──────────────────────────────────────────────────────────

    async def status(self, _req: web.Request) -> web.Response:
        active = self.active()
        by = {t: sum(1 for e in self.host.sessions.values() if e["transport"] == t) for t in ("webrtc", "ws")}
        by["webrtc"] += len(self.routes)
        return web.json_response({
            "active": active, "max": self.s.max_sessions, "available": max(0, self.s.max_sessions - active),
            "transports": ["webrtc", "ws"], "udpPorts": list(self.s.udp_ports), "ready": self.up.ready,
            "byTransport": by, "workers": len(self.workers),
        })

    async def worker_call(self, index: int, method: str, path: str, body: dict | None = None):
        url = f"http://127.0.0.1:{self.s.port + 1 + index}{path}"
        async with self.http.request(method, url, json=body, headers={INTERNAL_HEADER: self.secret},
                                     timeout=aiohttp.ClientTimeout(total=15)) as r:
            return r.status, await r.json(content_type=None)

    async def delete(self, req: web.Request) -> web.Response:
        sid = req.match_info["sid"]
        if sid in self.routes:
            route = self.routes.pop(sid)
            status, body = await self.worker_call(route["worker"], "DELETE", f"/__edge/session/{sid}")
            return web.json_response(body, status=status)
        ok = await self.host.end(sid, "deleted")
        return web.json_response({"deleted": ok}, status=200 if ok else 404)

    async def offer(self, req: web.Request) -> web.Response:
        try:
            body = await req.json()
            sdp, kind = body["sdp"], body.get("type", "offer")
            if kind != "offer" or not isinstance(sdp, str):
                raise ValueError("type must be offer")
        except Exception as error:  # noqa: BLE001
            return web.json_response(error_body("bad_request", f"{error}"), status=400)
        trace_id = trace_id_from(req.headers.get("traceparent") or body.get("traceparent")) or new_trace_id()
        claims, refused = self.admit(body.get("token"), trace_id)
        if refused:
            return web.json_response(error_body(refused[1], refused[2]), status=refused[0])
        if not self.workers:
            try:
                return web.json_response(await self.host.offer(sdp, claims, trace_id))
            except OfferError as error:
                return web.json_response(error_body("bad_request", str(error)), status=400)
        load = {i: 0 for i in range(len(self.workers))}
        for route in self.routes.values():
            load[route["worker"]] += 1
        index = min(load, key=load.get)
        sid = claims["sid"]
        self.routes[sid] = {"worker": index, "at": time.monotonic()}  # counts against capacity while the worker answers
        try:
            status, answer = await self.worker_call(index, "POST", "/__edge/offer", {"sdp": sdp, "claims": claims, "traceId": trace_id})
        except Exception as error:  # noqa: BLE001
            self.routes.pop(sid, None)
            return web.json_response(error_body("internal", f"rtc worker {index}: {error!r}"[:200]), status=502)
        if status != 200:
            self.routes.pop(sid, None)
        return web.json_response(answer, status=status)

    async def add_ice(self, req: web.Request) -> web.Response:
        try:
            body = await req.json()
            sid = body["sessionId"]
            if sid in self.routes:
                status, answer = await self.worker_call(self.routes[sid]["worker"], "POST", "/__edge/ice", body)
                return web.json_response(answer, status=status)
            ok = await self.host.add_ice(sid, body.get("candidate"))
            if not ok:
                return web.json_response(error_body("not_found", "no such session"), status=404)
            return web.json_response({"ok": True})
        except Exception as error:  # noqa: BLE001
            return web.json_response(error_body("bad_request", f"{error!r}"[:200]), status=400)

    # ── WebSocket ────────────────────────────────────────────────────────────

    async def websocket(self, req: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=1 << 20)
        await ws.prepare(req)
        trace_id = trace_id_from(req.headers.get("traceparent") or req.query.get("traceparent")) or new_trace_id()
        claims, refused = self.admit(req.query.get("token"), trace_id)
        if refused:
            await ws.send_str(json.dumps({"type": "error", "code": refused[1], "message": refused[2]}))
            await ws.close(code=4401 if refused[0] == 401 else 1013, message=refused[1].encode())
            return ws
        sid = claims["sid"]
        outbox: asyncio.Queue = asyncio.Queue()
        session = Session(sid, claims, self.s, self.up, lambda e: outbox.put_nowait(json.dumps(e)), "ws", trace_id)

        async def close(reason: str) -> None:
            await ws.close(code=1000, message=reason.encode()[:120])

        self.host.register(session, close)
        session.emit({"type": "ready", "sessionId": sid, "transport": "ws", "traceId": trace_id})
        writer = asyncio.create_task(self.ws_writer(ws, session, outbox))
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    data = msg.data
                    if data and data[0] == AUDIO_TAG:
                        session.feed(data[1:])
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        session.control(json.loads(msg.data))
                    except ValueError:
                        session.emit({"type": "error", "code": "bad_message", "message": "not JSON"})
                else:
                    break
        finally:
            writer.cancel()
            session.tel("edge.ws.close", code=ws.close_code)
            await self.host.end(sid, "ws_closed")
        return ws

    async def ws_writer(self, ws: web.WebSocketResponse, session: Session, outbox: asyncio.Queue) -> None:
        """Events as they come; audio in 20 ms frames, at most WS_LEAD_SECONDS ahead of real time."""
        clock: float | None = None
        try:
            while not ws.closed:
                while not outbox.empty():
                    await ws.send_str(outbox.get_nowait())
                now = time.monotonic()
                if clock is None or clock < now:
                    clock = now
                if session.out.buf and clock - now < WS_LEAD_SECONDS:
                    await ws.send_bytes(bytes([AUDIO_TAG]) + session.out.pull(OUT_FRAME_BYTES))
                    clock += 0.02
                    continue
                if not session.out.buf:
                    session.out.drained.set()
                try:
                    await ws.send_str(await asyncio.wait_for(outbox.get(), 0.01))
                except asyncio.TimeoutError:
                    pass
        except (ConnectionResetError, asyncio.CancelledError, RuntimeError):
            pass

    # ── workers ──────────────────────────────────────────────────────────────

    def start_worker(self, index: int) -> None:
        proc = mp.get_context("spawn").Process(target=worker_main, args=(self.worker_settings[index], index, self.secret),
                                               name=f"aigw-edge-rtc-{index}", daemon=True)
        proc.start()
        self.workers[index] = proc

    async def watch_workers(self) -> None:
        """Restart a dead worker; drop routes of sessions a worker no longer has (closed, timed out, crashed)."""
        while True:
            await asyncio.sleep(1)
            for index, proc in enumerate(self.workers):
                if proc is not None and not proc.is_alive():
                    telemetry.emit("edge.worker.restart", level="error", worker=index, exitCode=proc.exitcode)
                    for sid in [s for s, r in self.routes.items() if r["worker"] == index]:
                        self.routes.pop(sid, None)
                    self.start_worker(index)
                    continue
                try:
                    _, body = await self.worker_call(index, "GET", "/__edge/sessions")
                except Exception:  # noqa: BLE001 — starting up
                    continue
                live = set(body.get("sids", []))
                for sid, route in list(self.routes.items()):
                    if route["worker"] == index and sid not in live and time.monotonic() - route["at"] > 5:
                        self.routes.pop(sid, None)

    # ── app ──────────────────────────────────────────────────────────────────

    async def on_startup(self, _app) -> None:
        await self.up.start()
        self.http = aiohttp.ClientSession()
        for index in range(len(self.workers)):
            self.start_worker(index)
        self.host.spawn(self.up.health_loop())
        self.host.spawn(load_loop("front", self.active))
        if self.workers:
            self.host.spawn(self.watch_workers())

    async def on_cleanup(self, _app) -> None:
        await self.host.close_all()
        for proc in self.workers:
            if proc is not None:
                proc.terminate()
        await self.http.close()
        await self.up.close()
        telemetry.flush()

    def app(self) -> web.Application:
        app = web.Application(client_max_size=1 << 20)
        app.router.add_post("/__aigw/rt/offer", self.offer)
        app.router.add_post("/__aigw/rt/ice", self.add_ice)
        app.router.add_get("/__aigw/rt/status", self.status)
        app.router.add_delete("/__aigw/rt/session/{sid}", self.delete)
        app.router.add_get("/__aigw/rt/ws", self.websocket)
        app.on_startup.append(self.on_startup)
        app.on_cleanup.append(self.on_cleanup)
        return app


def main() -> None:
    settings = Settings.from_env()
    ice.install(settings)
    audio.install()
    edge = Edge(settings)
    print(f"[edge] {settings.bind}:{settings.port} upstream={settings.upstream} max={settings.max_sessions} "
          f"udp={settings.udp_ports} rtc_workers={settings.rtc_workers} public={settings.public_ip or '-'} "
          f"replica={settings.replica_id or '-'}", flush=True)
    if not settings.replica_id:
        print("[edge] AIGW_REPLICA_ID unknown: tokens are checked for signature, expiry and deployment only", flush=True)
    # The WS URL carries the session token: cfg ≤ 6144 base64url chars is base64url-encoded AGAIN inside the claims, so a
    # full token is ~8.4 KB — above aiohttp's 8190-byte request-line default (and nginx's 8k, see cloud-init.ts).
    web.run_app(edge.app(), host=settings.bind, port=settings.port, access_log=None, print=None,
                max_line_size=32768, max_field_size=32768)
