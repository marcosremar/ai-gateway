"""
End-to-end harness of the edge without a GPU: fake model container (fake_upstream.py) + the real edge process + test
learners over WebSocket and WebRTC (aiortc). Every check is an assert; the run prints a JSON summary with latencies.

    tests/run.sh harness        (creates a throwaway venv, runs this, deletes the venv)
"""

import asyncio
import json
import os
import statistics
import subprocess
import sys
import time
import uuid
from pathlib import Path

import aiohttp

from clients import REPLICA_TOKEN, DEFAULT_CFG, RtcLearner, WsLearner, mint

ROOT = Path(__file__).resolve().parents[1]
UP_PORT, EDGE_PORT, EDGE_S2S_PORT, GW_PORT, EDGE_VAST_PORT = 8900, 8920, 8940, 8950, 8970
VAST_IP, VAST_UDP, VAST_SHIFT = "203.0.113.7", (50061, 50067), -9000
TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
telemetry_batches: list[dict] = []
results: dict = {"checks": [], "latency": {}}


def check(name: str, ok: bool, detail=None) -> None:
    results["checks"].append({"name": name, "ok": bool(ok), **({"detail": detail} if detail is not None else {})})
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail is not None else ""), flush=True)
    if not ok:
        raise AssertionError(name)


def start_edge(port: int, **extra) -> subprocess.Popen:
    env = {**os.environ, "RT_PORT": str(port), "EDGE_UPSTREAM": f"http://127.0.0.1:{UP_PORT}",
           "AIGW_REPLICA_TOKEN": REPLICA_TOKEN, "AIGW_DEPLOYMENT": "parle-speech",
           "RT_MAX_SESSIONS": "3", "RT_UDP_PORTS": "50000-50040", "GATEWAY_URL": f"http://127.0.0.1:{GW_PORT}",
           "AIGW_REPLICA_ID": "fr-par-2:replica-1", "EDGE_TELEMETRY_STDOUT": "0", **extra}
    return subprocess.Popen([sys.executable, "-m", "aigw_edge"], cwd=ROOT, env=env)


async def wait_ready(base: str) -> None:
    async with aiohttp.ClientSession() as http:
        for _ in range(100):
            try:
                async with http.get(f"{base}/__aigw/rt/status") as r:
                    if r.status == 200 and (await r.json())["ready"]:
                        return
            except aiohttp.ClientError:
                pass
            await asyncio.sleep(0.1)
    raise RuntimeError(f"edge at {base} never became ready")


async def ws_turn(base: str, cfg: dict | None = None, seconds: float = 1.2) -> WsLearner:
    learner = await WsLearner(base).connect(mint(cfg))
    await learner.events.wait("ready")
    learner.say(seconds)
    return learner


async def scenario_ws(base: str) -> None:
    learner = await ws_turn(base)
    done = await learner.events.wait("done", 15)
    types = learner.events.types()
    finals = [e for e in learner.events.of("transcript") if e["final"]]
    check("ws: vad speech → silence", "vad" in types and learner.events.of("vad")[0]["state"] == "start")
    check("ws: final transcript", finals and finals[0]["text"] == "Bom dia, eu queria um pão francês.", finals)
    check("ws: reply_delta streamed", len(learner.events.of("reply_delta")) >= 5)
    order = [t for t in types if t in ("transcript", "audio_start", "audio_end", "metrics", "done")]
    check("ws: event order", order.index("audio_start") < order.index("audio_end") < order.index("metrics") < order.index("done"), order)
    check("ws: reply text", learner.events.of("reply")[0]["text"].startswith("Bom dia!"))
    check("ws: audio out (PCM16 24 kHz frames)", learner.audio_bytes >= 24000 * 2, f"{learner.audio_bytes} bytes")
    check("ws: done plain", not done.get("empty") and not done.get("filtered"))
    m = learner.events.of("metrics")[0]
    check("ws: metrics", all(isinstance(m[k], int) for k in ("ttfa_ms", "stt_ms", "llm_ttft_ms", "tts_ttfb_ms")), m)
    results["latency"]["ws_turn"] = {**{k: m[k] for k in ("ttfa_ms", "stt_ms", "llm_ttft_ms", "tts_ttfb_ms")},
                                    "client_ttfa_from_speech_end_ms": round((learner.first_audio_at - learner.speech_end_at) * 1000)}
    # second turn carries the history
    n = len(learner.events.items)
    learner.say(1.0)
    await learner.events.wait("done", 15, after=n)
    async with aiohttp.ClientSession() as http:
        async with http.get(f"http://127.0.0.1:{UP_PORT}/__stats") as r:
            stats = await r.json()
    roles = [msg["role"] for msg in stats["last_llm_messages"]]
    check("ws: history grows per turn", roles == ["system", "user", "assistant", "user"], roles)
    check("ws: catalog voice → cloning fields", stats["last_tts"]["task_type"] == "Base"
          and stats["last_tts"]["ref_audio"].endswith("/refs/br-m-08.wav"), stats["last_tts"])
    check("ws: no partial transcripts by default (EDGE_STT_PARTIALS unset)", stats["partials"] == 0
          and all(e["final"] for e in learner.events.of("transcript")), stats["partials"])
    await learner.close()


async def scenario_client_vad(base: str) -> None:
    learner = await WsLearner(base).connect(mint({**DEFAULT_CFG, "vad": "client"}))
    await learner.events.wait("ready")
    learner.say(1.0)
    await asyncio.sleep(1.6)
    check("ws client-vad: no turn before end_turn", "done" not in learner.events.types())
    t = time.monotonic()
    await learner.send({"type": "end_turn"})
    await learner.events.wait("audio_start", 10)
    while learner.first_audio_at is None:
        await asyncio.sleep(0.005)
    results["latency"]["client_end_turn_to_audio_ms"] = round((learner.first_audio_at - t) * 1000)
    await learner.events.wait("done", 10)
    check("ws client-vad: end_turn answers", True, results["latency"]["client_end_turn_to_audio_ms"])
    await learner.close()


async def scenario_filtered(base: str) -> None:
    learner = await ws_turn(base, {**DEFAULT_CFG, "stt_prompt": "FAKE:Legendas pela comunidade Amara.org"})
    done = await learner.events.wait("done", 10)
    filtered = learner.events.of("filtered")
    check("filtered: hallucination dropped", filtered and done.get("filtered") is True, filtered)
    check("filtered: no LLM/TTS after it", "reply" not in learner.events.types() and learner.audio_bytes == 0)
    await learner.close()
    learner = await ws_turn(base, {**DEFAULT_CFG, "stt_prompt": "FAKE:E aí E aí E aí E aí"})
    await learner.events.wait("done", 10)
    check("filtered: pattern rule (repetition / blocklist)", bool(learner.events.of("filtered")), learner.events.of("filtered"))
    await learner.close()


async def scenario_barge_in(base: str) -> None:
    learner = await ws_turn(base)
    await learner.events.wait("audio_start", 10)
    await asyncio.sleep(0.3)
    learner.say(1.0)  # the learner talks over the NPC
    await learner.events.wait("interrupted", 5)
    check("barge-in: speech over NPC audio → interrupted", True)
    after = learner.events.types().index("interrupted") + 1
    check("barge-in: interrupted is followed by done{interrupted}", learner.events.items[after][1] == {
        "type": "done", "interrupted": True, "turnId": learner.events.items[after][1].get("turnId")})
    await learner.events.wait("metrics", 15, after=after)
    check("barge-in: the new turn is answered", [e["final"] for e in learner.events.of("transcript")].count(True) >= 2)
    n = len(learner.events.items)
    learner.say(1.0)
    await learner.events.wait("reply_delta", 10, after=n)
    await learner.send({"type": "interrupt"})
    await learner.events.wait("interrupted", 5, after=n)
    check("interrupt message cancels the turn", True)
    await learner.send({"type": "ping", "t": 1})
    pong = await learner.events.wait("pong", 3)
    check("ping → pong", pong.get("t") == 1)
    await learner.close()


async def scenario_tokens(base: str) -> None:
    async def refused(token: str) -> dict:
        learner = await WsLearner(base).connect(token)
        err = await learner.events.wait("error", 5)
        await learner.events.wait("__closed", 5)
        code = learner.close_code
        await learner.close()
        return {**err, "close": code}

    from clients import KEY  # noqa: PLC0415
    bad_sig = mint(key=bytes(32))
    expired = mint(ttl=60, iat_shift=-120)
    long_lived = mint(ttl=3600)
    wrong_rep = mint(rep="fr-par-2:replica-2")
    wrong_dep = mint(dep="other")
    for name, token in [("bad signature", bad_sig), ("expired", expired), ("lifetime > 15 min", long_lived),
                        ("wrong replica", wrong_rep), ("wrong deployment", wrong_dep), ("garbage", "abc.def")]:
        err = await refused(token)
        check(f"token rejected: {name}", err["code"] == "unauthorized" and err["close"] == 4401, err["message"])
    token = mint()
    learner = await WsLearner(base).connect(token)
    await learner.events.wait("ready")
    await learner.close()
    err = await refused(token)
    check("token rejected: replay of a used sid", err["code"] == "unauthorized" and "replayed" in err["message"])
    async with aiohttp.ClientSession() as http:
        async with http.post(f"{base}/__aigw/rt/offer", json={"sdp": "v=0", "type": "offer", "token": bad_sig}) as r:
            body = await r.json()
            check("offer with bad token → 401", r.status == 401 and body["error"]["code"] == "unauthorized")
    _ = KEY


async def scenario_capacity(base: str) -> None:
    learners = [await WsLearner(base).connect(mint()) for _ in range(3)]
    for learner in learners:
        await learner.events.wait("ready")
    async with aiohttp.ClientSession() as http:
        async with http.get(f"{base}/__aigw/rt/status") as r:
            status = await r.json()
    check("status: 3/3 active, 0 available", status["active"] == 3 and status["available"] == 0
          and status["transports"] == ["webrtc", "ws"] and status["udpPorts"] == [50000, 50040], status)
    fourth = await WsLearner(base).connect(mint())
    err = await fourth.events.wait("error", 5)
    check("capacity: 4th session refused with code capacity", err["code"] == "capacity", err["message"])
    await fourth.close()
    async with aiohttp.ClientSession() as http:
        async with http.post(f"{base}/__aigw/rt/offer", json={"sdp": "v=0", "type": "offer", "token": mint()}) as r:
            body = await r.json()
            check("capacity: offer refused 503 capacity", r.status == 503 and body["error"]["code"] == "capacity")
    for learner in learners:
        await learner.close()
    await asyncio.sleep(0.3)


async def scenario_webrtc(base: str, udp: tuple[int, int] = (50000, 50040)) -> None:
    t = time.monotonic()
    learner = await RtcLearner(base).connect(mint())
    check("webrtc: offer → answer", learner.status == 200 and learner.answer["type"] == "answer"
          and "a=candidate" in learner.answer["sdp"], learner.answer.get("sessionId"))
    ports = [int(line.split()[5]) for line in learner.answer["sdp"].splitlines() if line.startswith("a=candidate")]
    check("webrtc: candidate ports inside RT_UDP_PORTS", ports and all(udp[0] <= p <= udp[1] for p in ports), ports)
    await learner.events.wait("ready", 10)
    results["latency"]["webrtc_connect_ms"] = round((time.monotonic() - t) * 1000)
    learner.mic.say(1.2)
    await learner.events.wait("done", 15)
    types = learner.events.types()
    check("webrtc: transcript, reply, audio_start/end, metrics, done", all(k in types for k in
          ("transcript", "reply_delta", "reply", "audio_start", "audio_end", "metrics", "done")), types)
    check("webrtc: Opus audio heard by the learner", learner.loud_frames >= 50, f"{learner.loud_frames} loud 20 ms frames")
    m = learner.events.of("metrics")[0]
    results["latency"][f"webrtc_turn_{base[-4:]}"] = {**{k: m[k] for k in ("ttfa_ms", "stt_ms", "llm_ttft_ms", "tts_ttfb_ms")},
                                        "client_ttfa_from_speech_end_ms": round((learner.first_audio_at - learner.mic.speech_end_at) * 1000)}
    async with aiohttp.ClientSession() as http:
        async with http.delete(f"{base}/__aigw/rt/session/{learner.session_id}") as r:
            check("DELETE session", r.status == 200)
        async with http.get(f"{base}/__aigw/rt/status") as r:
            check("status after delete: 0 active", (await r.json())["active"] == 0)
    await learner.close()


async def scenario_vast(base: str) -> None:
    lo, hi = VAST_UDP
    async with aiohttp.ClientSession() as http:
        async with http.get(f"{base}/__aigw/rt/status") as r:
            status = await r.json()
    check("vast: status reports the mapped probe port and PUBLIC_IPADDR", status["probePort"] == hi + VAST_SHIFT
          and status["net"]["probePort"] == hi + VAST_SHIFT and status["net"]["publicIp"] == VAST_IP, status["net"])
    learner = await RtcLearner(base).connect(mint())
    lines = [line.split() for line in learner.answer.get("sdp", "").splitlines() if line.startswith("a=candidate")]
    media = {port + VAST_SHIFT for port in range(lo, hi)}
    check("vast: every candidate carries PUBLIC_IPADDR and a mapped media port", learner.status == 200 and lines
          and all(c[4] == VAST_IP and int(c[5]) in media for c in lines), [(c[4], c[5]) for c in lines] or learner.answer)
    check("vast: one bind address → one UDP port per session", len({c[5] for c in lines}) == 1)
    loop = asyncio.get_running_loop()
    reply = loop.create_future()

    class Probe(asyncio.DatagramProtocol):
        def datagram_received(self, data, _addr):
            reply.done() or reply.set_result(data)

    transport, _ = await loop.create_datagram_endpoint(Probe, remote_addr=("127.0.0.1", hi))
    transport.sendto(b"AIGWP1" + b"n" * 16)
    echoed = await asyncio.wait_for(reply, 2)
    transport.close()
    check("vast: the probe responder answers on the container port behind the mapping", echoed == b"AIGWR1" + b"n" * 16)
    async with aiohttp.ClientSession() as http:
        async with http.delete(f"{base}/__aigw/rt/session/{learner.session_id}") as r:
            check("vast: DELETE session", r.status == 200)
    await learner.close()


async def scenario_reoffer(base: str) -> None:
    async def offer_status(token: str, sdp: str) -> tuple[int, dict]:
        async with aiohttp.ClientSession() as http:
            async with http.post(f"{base}/__aigw/rt/offer", json={"sdp": sdp, "type": "offer", "token": token}) as r:
                return r.status, await r.json()

    async def active() -> int:
        async with aiohttp.ClientSession() as http:
            async with http.get(f"{base}/__aigw/rt/status") as r:
                return (await r.json())["active"]

    sid = uuid.uuid4().hex
    token = mint(sid=sid)
    first = await RtcLearner(base).connect(token)
    await first.events.wait("ready", 10)
    first.mic.say(1.2)
    await first.events.wait("transcript", 15)
    second = await RtcLearner(base).connect(token)
    check("re-offer of a live session: accepted, same session id", second.status == 200 and second.session_id == sid,
          second.answer.get("error"))
    done = await second.events.wait("done", 15)
    check("re-offer: the turn in progress ends on the new peer connection", done.get("turnId", "").endswith(":1")
          and "done" not in first.events.types(), second.events.types())
    check("re-offer: no second ready, one session on the replica", "ready" not in second.events.types() and await active() == 1)
    for _ in range(50):
        if first.pc.connectionState in ("closed", "failed") or first.dc.readyState == "closed":
            break
        await asyncio.sleep(0.1)
    check("re-offer: the previous peer connection is closed by the edge",
          first.pc.connectionState in ("closed", "failed") or first.dc.readyState == "closed", first.pc.connectionState)
    seen = len(second.events.items)
    second.mic.say(1.2)
    done = await second.events.wait("done", 15, after=seen)
    check("re-offer: the session kept its turns (second turn of the same session)", done.get("turnId", "").endswith(":2"), done)
    sdp = second.pc.localDescription.sdp
    status, body = await offer_status(mint(sid=sid, ttl=500), sdp)
    check("re-offer with another token of the same sid → 401 replayed", status == 401 and "replayed" in body["error"]["message"], body)
    check("re-offer refused: the live session is untouched", await active() == 1)
    async with aiohttp.ClientSession() as http:
        async with http.delete(f"{base}/__aigw/rt/session/{sid}") as r:
            check("re-offer: DELETE ends the session", r.status == 200 and await active() == 0)
    status, body = await offer_status(token, sdp)
    check("re-offer after the session ended → 401 replayed", status == 401 and "replayed" in body["error"]["message"], body)
    fallback = await WsLearner(base).connect(token)
    await fallback.events.wait("ready")
    status, body = await offer_status(token, sdp)
    check("re-offer while the sid only lives on WS → 401 replayed", status == 401 and "replayed" in body["error"]["message"], body)
    await fallback.close()
    await first.close()
    await second.close()
    await asyncio.sleep(0.3)


async def scenario_race(base: str, stages: bool) -> None:
    async def status() -> dict:
        async with aiohttp.ClientSession() as http:
            async with http.get(f"{base}/__aigw/rt/status") as r:
                return await r.json()

    sid = uuid.uuid4().hex
    token = mint(sid=sid)
    ws = await WsLearner(base).connect(token)
    await ws.events.wait("ready")
    others = [await WsLearner(base).connect(mint()) for _ in range(2)]
    for other in others:
        await other.events.wait("ready")
    rtc = await RtcLearner(base).connect(token, standby=True)
    check("race: on a full replica the learner's own WebRTC offer is accepted while its WS session runs",
          rtc.status == 200 and rtc.session_id == sid, rtc.answer.get("error"))
    await rtc.events.wait("ready", 10)
    now = await status()
    check("race: both transports live, the learner counts once", now["active"] == 3 and now["available"] == 0
          and now["byTransport"] == {"webrtc": 1, "ws": 3} and "__closed" not in ws.events.types(), now)
    for other in others:
        await other.close()
    ws.say(1.2)
    await ws.events.wait("done", 15)
    await asyncio.sleep(0.3)
    check("race: the turn spoken on WS runs once, the standby WebRTC session hears nothing",
          rtc.events.types() == ["ready"] and rtc.loud_frames == 0, rtc.events.types())
    await ws.close()
    await asyncio.sleep(0.5)
    now = await status()
    check("race: closing the WS frees nothing but the WS, WebRTC carries on", now["active"] == 1
          and now["byTransport"] == {"webrtc": 1, "ws": 0}, now)
    rtc.activate()
    await rtc.send({"type": "config_update", "messages": [{"role": "user", "content": "Bom dia"}, {"role": "assistant", "content": "Olá!"}]})
    rtc.mic.say(1.2)
    done = await rtc.events.wait("done", 15)
    check("race: after the switch the microphone reaches the WebRTC session", done.get("turnId", "").endswith(":1")
          and rtc.loud_frames >= 50, f"{rtc.loud_frames} loud frames")
    if stages:
        async with aiohttp.ClientSession() as http:
            async with http.get(f"http://127.0.0.1:{UP_PORT}/__stats") as r:
                roles = [msg["role"] for msg in (await r.json())["last_llm_messages"]]
        check("race: the replayed history reaches the model", roles == ["system", "user", "assistant", "user"], roles)
    await rtc.close()
    async with aiohttp.ClientSession() as http:
        async with http.delete(f"{base}/__aigw/rt/session/{sid}") as r:
            await r.read()
    check("race: the slot is free once the WebRTC session ends", (await status())["active"] == 0)

    sid = uuid.uuid4().hex
    token = mint(sid=sid)
    rtc = await RtcLearner(base).connect(token, standby=True)
    await rtc.events.wait("ready", 10)
    ws = await WsLearner(base).connect(token)
    await ws.events.wait("ready")
    async with aiohttp.ClientSession() as http:
        async with http.delete(f"{base}/__aigw/rt/session/{sid}") as r:
            deleted = r.status
    now = await status()
    check("race: giving up the WebRTC attempt (DELETE) leaves the WS session running", deleted == 200 and now["active"] == 1
          and now["byTransport"] == {"webrtc": 0, "ws": 1} and "__closed" not in ws.events.types(), now)
    ws.say(1.2)
    await ws.events.wait("done", 15)
    await ws.close()
    await rtc.close()
    await asyncio.sleep(0.3)
    check("race: the slot is free once the WS closes", (await status())["active"] == 0)


async def scenario_s2s(base: str) -> None:
    learner = await ws_turn(base)
    await learner.events.wait("done", 15)
    types = learner.events.types()
    check("s2s mode: transcript → reply → audio → done", all(k in types for k in
          ("transcript", "reply_delta", "reply", "audio_start", "audio_end", "metrics", "done")), types)
    results["latency"]["s2s_turn"] = learner.events.of("metrics")[0]
    async with aiohttp.ClientSession() as http:
        async with http.get(f"http://127.0.0.1:{UP_PORT}/__stats") as r:
            check("EDGE_STT_PARTIALS=1: partial transcripts relayed", (await r.json())["partials"] >= 1)
    await learner.close()
    learner = await ws_turn(base, {**DEFAULT_CFG, "stt_prompt": "FAKE:Obrigado por assistir"})
    done = await learner.events.wait("done", 10)
    check("s2s mode: hallucination guard aborts the call", done.get("filtered") is True and learner.audio_bytes == 0)
    await learner.close()


async def fake_gateway():
    """The gateway's telemetry ingest, as the contract defines it (POST /v1/telemetry/events)."""
    from aiohttp import web  # noqa: PLC0415

    async def ingest(request):
        telemetry_batches.append({"auth": request.headers.get("Authorization"), "replica": request.headers.get("X-Aigw-Replica"),
                                  "body": await request.json(), "raw": (await request.read()).decode()})
        return web.json_response({"accepted": True})

    app = web.Application()
    app.router.add_post("/v1/telemetry/events", ingest)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", GW_PORT).start()
    return runner


async def scenario_telemetry(base: str) -> None:
    import hashlib  # noqa: PLC0415
    import hmac  # noqa: PLC0415

    learner = WsLearner(base)
    learner.http = aiohttp.ClientSession()
    # The gateway's relay passes the trace as a query parameter on the WS URL (docs/realtime.md § Trace).
    learner.ws = await learner.http.ws_connect(f"{base}/__aigw/rt/ws?token={mint()}&traceparent=00-{TRACE}-00f067aa0ba902b7-01")
    learner.tasks.append(asyncio.create_task(learner._read()))
    learner.tasks.append(asyncio.create_task(learner._mic()))
    ready = await learner.events.wait("ready")
    check("trace: ?traceparent= on the WS URL is the session's trace", ready.get("traceId") == TRACE)
    learner.say(1.2)
    await learner.events.wait("done", 15)
    await learner.close()
    async with aiohttp.ClientSession() as http:
        async with http.get(f"http://127.0.0.1:{UP_PORT}/__stats") as r:
            traces = (await r.json())["traces"]
    check("trace: forwarded to the model calls", set(traces.get(TRACE, [])) >= {"/v1/audio/transcriptions",
          "/v1/chat/completions", "/v1/audio/speech"}, traces.get(TRACE))
    deadline = time.monotonic() + 12
    names: set = set()
    while time.monotonic() < deadline:
        names = {e["event"] for b in telemetry_batches for e in b["body"]["events"] if e.get("traceId") == TRACE}
        if {"edge.session.close", "edge.turn.done"} <= names:
            break
        await asyncio.sleep(0.5)
    want = {"edge.session.open", "edge.stt.done", "edge.llm.first_token", "edge.tts.first_audio", "edge.turn.done",
            "edge.ws.close", "edge.session.close"}
    check("telemetry: session/turn events reach the gateway", want <= names, sorted(names))
    all_names = {e["event"] for b in telemetry_batches for e in b["body"]["events"]}
    check("telemetry: capacity/token rejects reported", {"edge.capacity.reject", "edge.token.reject"} <= all_names)
    expected_auth = "Bearer " + hmac.new(REPLICA_TOKEN.encode(), b"aigw-telemetry-v1", hashlib.sha256).hexdigest()
    check("telemetry: HMAC credential + X-Aigw-Replica", all(b["auth"] == expected_auth and b["replica"] == "fr-par-2:replica-1"
                                                             for b in telemetry_batches))
    raw = " ".join(b["raw"] for b in telemetry_batches)
    check("telemetry: no transcript, reply text or token in any event",
          "pão" not in raw and "Bom dia" not in raw and "Legendas" not in raw and REPLICA_TOKEN not in raw and "eyJ" not in raw)
    events = [e for b in telemetry_batches for e in b["body"]["events"]]
    check("telemetry: event shape", all(set(e) <= {"ts", "source", "level", "event", "traceId", "sessionId", "turnId", "durMs", "attrs"}
                                        and "replicaId" not in e and "deployment" not in e and isinstance(e["ts"], int) for e in events))
    stt = next(e for e in events if e["event"] == "edge.stt.done" and e.get("traceId") == TRACE)
    check("telemetry: stt.done has durMs, filtered flag and turnId", isinstance(stt.get("durMs"), int)
          and stt["attrs"]["filtered"] is False and stt.get("turnId", "").endswith(":1"), stt)
    results["telemetry_events"] = len(events)


NGINX_PORT, GATE_TOKEN = 8960, "harness-gate-token-0123456789abcdef"


def start_nginx():
    """The replica's real front: the nginx config the gateway's cloud-init generates (nginxConfig in
    src/deployments/cloud-init.ts, printed by bun), token gate included. Skipped without nginx or bun."""
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    repo = ROOT.parents[1]
    if not shutil.which("nginx") or not shutil.which("bun") or not (repo / "src/deployments/cloud-init.ts").exists():
        return None, None
    conf = subprocess.run(["bun", "-e", f"import {{ nginxConfig }} from './src/deployments/cloud-init'; "
                           f"console.log(nginxConfig('{GATE_TOKEN}', {NGINX_PORT}, {UP_PORT}, {EDGE_PORT}))"],
                          cwd=repo, capture_output=True, text=True, check=True).stdout
    d = tempfile.mkdtemp(prefix="aigw-harness-nginx-")
    Path(d, "aigw.conf").write_text(conf)
    Path(d, "nginx.conf").write_text(
        f"pid {d}/nginx.pid; error_log {d}/error.log; daemon off; events {{}}\n"
        f"http {{ access_log off; client_body_temp_path {d}; proxy_temp_path {d}; fastcgi_temp_path {d}; "
        f"uwsgi_temp_path {d}; scgi_temp_path {d}; include {d}/aigw.conf; }}\n")
    return subprocess.Popen(["nginx", "-p", d, "-c", f"{d}/nginx.conf"]), d


async def scenario_nginx() -> None:
    front = f"http://127.0.0.1:{NGINX_PORT}"
    big_cfg = {**DEFAULT_CFG, "system": "x" * 4400}  # ~6 KB of base64url cfg in the URL, the contract's maximum
    token = mint(big_cfg)
    check("nginx: max-size token (cfg ≈ 6 KB, ~8.3 KB token) in the URL", len(token) > 8000, len(token))
    async with aiohttp.ClientSession() as http:
        async with http.get(f"{front}/__aigw/rt/status") as r:
            check("nginx: /__aigw/rt/* without X-Aigw-Token → 401", r.status == 401)
        async with http.get(f"{front}/__aigw/rt/status", headers={"X-Aigw-Token": GATE_TOKEN}) as r:
            check("nginx: status through the gate", r.status == 200 and (await r.json())["max"] == 3)
        try:
            await http.ws_connect(f"{front}/__aigw/rt/ws?token={token}")
            check("nginx: WS without X-Aigw-Token refused", False)
        except aiohttp.WSServerHandshakeError as error:
            check("nginx: WS without X-Aigw-Token refused", error.status == 401)
    learner = WsLearner(front)
    learner.http = aiohttp.ClientSession(headers={"X-Aigw-Token": GATE_TOKEN})
    learner.ws = await learner.http.ws_connect(f"{front}/__aigw/rt/ws?token={token}")
    learner.tasks.append(asyncio.create_task(learner._read()))
    learner.tasks.append(asyncio.create_task(learner._mic()))
    await learner.events.wait("ready")
    learner.say(1.2)
    await learner.events.wait("done", 15)
    check("nginx: WS upgrade through the token gate, 6 KB token, full turn", learner.audio_bytes > 0)
    await learner.close()
    t = time.monotonic()
    rtc = RtcLearner(front)
    # The offer goes through nginx (the gateway's signaling path); media goes straight to the edge's UDP ports.
    import clients  # noqa: PLC0415
    orig = clients.aiohttp.ClientSession
    clients.aiohttp.ClientSession = lambda *a, **k: orig(*a, headers={"X-Aigw-Token": GATE_TOKEN}, **k)
    try:
        await rtc.connect(mint())
    finally:
        clients.aiohttp.ClientSession = orig
    check("nginx: WebRTC offer through the gate", rtc.status == 200)
    await rtc.events.wait("ready", 10)
    rtc.mic.say(1.2)
    await rtc.events.wait("done", 15)
    check("nginx: WebRTC turn after gated signaling", rtc.loud_frames > 20, round((time.monotonic() - t) * 1000))
    await rtc.close()


async def main() -> int:
    gw = await fake_gateway()
    nginx, nginx_dir = start_nginx()
    up = subprocess.Popen([sys.executable, str(ROOT / "tests" / "fake_upstream.py"), "--port", str(UP_PORT)])
    edge = start_edge(EDGE_PORT)
    # The second edge runs everything in one process (RT_RTC_WORKERS=0) and answers turns through /v1/s2s.
    edge_s2s = start_edge(EDGE_S2S_PORT, EDGE_UPSTREAM_MODE="s2s", RT_UDP_PORTS="50041-50060", RT_RTC_WORKERS="0",
                          EDGE_STT_PARTIALS="1")
    edge_vast = start_edge(EDGE_VAST_PORT, RT_UDP_PORTS=f"{VAST_UDP[0]}-{VAST_UDP[1]}", PUBLIC_IPADDR=VAST_IP, RT_UDP_BIND="0.0.0.0",
                           **{f"VAST_UDP_PORT_{p}": str(p + VAST_SHIFT) for p in range(VAST_UDP[0], VAST_UDP[1] + 1)})
    base, base_s2s, base_vast = (f"http://127.0.0.1:{p}" for p in (EDGE_PORT, EDGE_S2S_PORT, EDGE_VAST_PORT))
    try:
        await wait_ready(base)
        await wait_ready(base_s2s)
        await wait_ready(base_vast)
        for scenario in (scenario_tokens, scenario_ws, scenario_client_vad, scenario_filtered, scenario_barge_in,
                         scenario_capacity, scenario_webrtc):
            await scenario(base)
        await scenario_reoffer(base)
        await scenario_race(base, stages=True)
        await scenario_s2s(base_s2s)
        await scenario_webrtc(base_s2s, (50041, 50060))
        await scenario_reoffer(base_s2s)
        await scenario_race(base_s2s, stages=False)
        await scenario_telemetry(base)
        await scenario_vast(base_vast)
        if nginx:
            await scenario_nginx()
        else:
            print("SKIP nginx scenario (no nginx or bun)")
        return 0
    except Exception as error:  # noqa: BLE001
        results["error"] = repr(error)
        print("ERROR", repr(error), flush=True)
        return 1
    finally:
        for proc in (edge, edge_s2s, edge_vast, up, nginx):
            if proc:
                proc.terminate()
        if nginx_dir:
            import shutil  # noqa: PLC0415
            shutil.rmtree(nginx_dir, ignore_errors=True)
        await gw.cleanup()
        passed = sum(1 for c in results["checks"] if c["ok"])
        results["summary"] = f"{passed}/{len(results['checks'])} checks passed"
        print(json.dumps(results["latency"], indent=1))
        print(results["summary"])
        _ = statistics


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
