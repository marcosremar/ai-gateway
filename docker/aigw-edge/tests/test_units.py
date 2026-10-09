"""Unit tests of the edge's pure parts (no network): python tests/test_units.py (needs numpy for the VAD)."""

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aigw_edge import text  # noqa: E402
from aigw_edge.config import derive_key  # noqa: E402
from aigw_edge.token import TokenError, TokenVerifier, b64url, sign  # noqa: E402

failures = 0


def check(name, ok):
    global failures
    print(("PASS " if ok else "FAIL ") + name)
    failures += 0 if ok else 1


# text.py is a verbatim copy of the speech-stack's cutter and JSON field extractor.
server = (ROOT.parent / "speech-stack" / "server.py")
if server.exists():
    src = server.read_text()
    body = src[src.index("SENTENCE_END ="):src.index("LLM_TIMINGS =")].rstrip()
    check("text.py = speech-stack server.py cut/JsonField", body in (ROOT / "aigw_edge" / "text.py").read_text())
    edge_tts = (ROOT / "aigw_edge" / "upstream.py").read_text()
    check("upstream.py = speech-stack server.py silence rule and codec frame rate",
          src[src.index("def silent("):src.index("async def tts_stream")].rstrip() in edge_tts
          and all(line in edge_tts for line in ("TTS_SILENCE_RMS = 300\n", "TTS_FRAMES_PER_SECOND = 12.5\n") if line in src))


def stream(t: str) -> list[str]:
    out, buf, first = [], "", True
    for ch in t:
        buf += ch
        while True:
            chunk, buf = text.cut(buf, first, False)
            if not chunk:
                break
            out.append(chunk)
            first = False
    chunk, _ = text.cut(buf, first, True)
    return out + ([chunk] if chunk else [])


check("cutter: clause first, then sentences", stream("Bom dia, minha senhora! Quer um pão? Custa 3,50 reais.")
      == ["Bom dia, minha senhora!", "Quer um pão?", "Custa 3,50 reais."])

key = derive_key("replica-token-abcdefghijklmnopqrstuvwxyz")
now = time.time()
v = TokenVerifier(key, replica_id="11111111-2222", deployment="dep")
cfg = b64url(b'{"voice":"br-m-08"}')
good = {"sid": "s1", "app": "a", "dep": "dep", "rep": "fr-par-2:11111111-2222", "cfg": cfg, "iat": int(now), "exp": int(now) + 300}
claims = v.verify(sign(good, key))
check("token: zone:uuid rep matches bare uuid; cfg decoded", claims["cfg"] == {"voice": "br-m-08"})


def rejects(claims_, reason, k=key):
    try:
        v.verify(sign(claims_, k))
    except TokenError as e:
        return e.reason == reason
    return False


check("token: replay", rejects(good, "replayed"))
ladder = sign({**good, "sid": "s-ladder"}, key)
v.verify(ladder, transport="webrtc")
check("token: the ladder's next rung (ws) may use the token webrtc used", v.verify(ladder, transport="ws")["sid"] == "s-ladder")


def rejects_on(token_, transport):
    try:
        v.verify(token_, transport=transport)
    except TokenError as e:
        return e.reason == "replayed"
    return False


check("token: but each transport only once", rejects_on(ladder, "webrtc") and rejects_on(ladder, "ws"))


def replayed(token_, live):
    try:
        v.verify(token_, transport="webrtc", live=live)
    except TokenError as e:
        return e.reason == "replayed"
    return False


alive = {"s-reoffer"}
reoffer = sign({**good, "sid": "s-reoffer"}, key)
v.verify(reoffer, transport="webrtc", live=alive.__contains__)
check("token: the token that opened a live WebRTC session may offer again",
      v.verify(reoffer, consume=False, transport="webrtc", live=alive.__contains__)["sid"] == "s-reoffer"
      and v.verify(reoffer, transport="webrtc", live=alive.__contains__)["sid"] == "s-reoffer")
check("token: another token of the same live sid is replayed",
      replayed(sign({**good, "sid": "s-reoffer", "exp": good["exp"] - 1}, key), alive.__contains__))
check("token: a re-offer without a live-session check is replayed", rejects_on(reoffer, "webrtc"))
check("token: a live WebRTC session does not let its token open a second WS",
      v.verify(reoffer, transport="ws")["sid"] == "s-reoffer" and rejects_on(reoffer, "ws"))
alive.clear()
check("token: once the session ended its token is replayed", replayed(reoffer, alive.__contains__))
check("token: expired", rejects({**good, "sid": "s2", "iat": int(now) - 400, "exp": int(now) - 100}, "expired"))
check("token: lifetime", rejects({**good, "sid": "s3", "exp": int(now) + 3600}, "ttl_too_long"))
check("token: replica", rejects({**good, "sid": "s4", "rep": "fr-par-2:other"}, "replica"))
check("token: deployment", rejects({**good, "sid": "s5", "dep": "x"}, "deployment"))
check("token: signature", rejects({**good, "sid": "s6"}, "bad_signature", k=b"x" * 32))
check("token: key derivation is HMAC-SHA256(key=token, msg='aigw-rt-v1')",
      derive_key("t" * 32).hex() == __import__("hmac").new(b"t" * 32, b"aigw-rt-v1", "sha256").hexdigest())

# The gateway's contract vectors (docs/realtime-token-vectors.json in the gateway, copied here).
import json  # noqa: E402

from aigw_edge.token import turn_credential  # noqa: E402

vec = json.loads((Path(__file__).with_name("realtime-token-vectors.json")).read_text())
check("vectors: derived key", derive_key(vec["replicaToken"]).hex() == vec["derivedKeyHex"])
for case in vec["cases"]:
    verifier = TokenVerifier(derive_key(vec["replicaToken"]), now=lambda c=case: c["nowSeconds"])
    try:
        got = verifier.verify(case["token"])
        reason = "valid" if got["cfg"] == vec["config"] else "cfg mismatch"
    except TokenError as error:
        reason = error.reason
    check(f"vectors: {case['name']} → {case['expect']}", reason == case["expect"])
t = vec["turn"]
check("vectors: TURN credential", turn_credential(t["secret"], t["sessionId"], t["expiresAtSeconds"]) == (t["username"], t["credential"]))

history_vectors = ROOT.parents[1] / "docs" / "s2s-history-vectors.json"
if history_vectors.exists():
    for case in json.loads(history_vectors.read_text())["cases"]:
        kept = text.fit_history(case["system"], case["history"], case["user"], case["max_tokens"], case["ctx"], case.get("harder", False))
        check(f"history: {case['name']}", kept == [case["history"][i] for i in case["kept"]])
shop_clerk = " ".join(["Você é a atendente da padaria e responde curto, com uma frase só, sempre em português."] * 21)
check("history: the estimate is over the 509 tokens llama.cpp counted for a 332-word Portuguese prompt (3 bytes per token)",
      328 <= len(shop_clerk.split()) <= 340 and text.estimate_tokens(shop_clerk) >= 509 * 1.2)
check("history: an accented letter counts by its bytes, an empty text costs nothing",
      text.estimate_tokens("ééé") == text.MESSAGE_TOKENS + 2 and text.estimate_tokens("") == text.estimate_tokens(None) == 0)

try:
    import asyncio

    from aiohttp import web

    from aigw_edge.config import Settings
    from aigw_edge.upstream import Upstream, UpstreamError, health_llm_ctx

    check("upstream: /health llm_ctx is read when it is there, any other body keeps the default",
          health_llm_ctx(b'{"ok": true, "llm_ctx": 4096}') == 4096 and health_llm_ctx(b"ok") is None
          and health_llm_ctx(b'{"ok": true}') is None and Upstream(Settings()).llm_ctx == text.DEFAULT_SLOT_CTX)

    async def cut_tts_stream():
        async def speech(request):
            res = web.StreamResponse()
            await res.prepare(request)
            await res.write(b"\x10\x27" * 2400)
            request.transport.close()
            return res

        app = web.Application()
        app.router.add_post("/v1/audio/speech", speech)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        up = Upstream(Settings(upstream=f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"))
        await up.start()
        got, error = 0, None
        try:
            async for chunk in up.speak("oi", {}, {"voice": "x"}):
                got += len(chunk)
        except Exception as raised:  # noqa: BLE001
            error = raised
        await up.close()
        await runner.cleanup()
        return got, error

    got, error = asyncio.run(cut_tts_stream())
    check("upstream: a TTS stream cut mid-body, after audible audio, raises UpstreamError with stage tts",
          got == 4800 and isinstance(error, UpstreamError) and error.stage == "tts" and error.status is None)

    import logging

    import fake_upstream

    logging.getLogger("aiohttp.server").setLevel(logging.CRITICAL)

    async def tts_guard():
        runner = web.AppRunner(fake_upstream.app())
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        up = Upstream(Settings(upstream=f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"))
        await up.start()
        out = {}
        for name, text, faults in (("runaway", "Bom dia!", ["runaway"]), ("twice", "Bom dia!", ["runaway", "runaway"]),
                                   ("break", "Bom dia!", ["break"]), ("cut", "Bom dia!", ["cut"]),
                                   ("lead", "Bom dia!", ["lead"]), ("late", "Bom dia!", ["break", "lead"]),
                                   ("long", "a" * 160, [])):
            fake_upstream.tts_faults.update({text: list(faults)})
            mark, pcm, retries, error = len(fake_upstream.calls["tts_log"]), b"", [], None
            try:
                async for chunk in up.speak(text, {}, {"voice": "x"}, None, retries.append):
                    pcm += chunk
            except UpstreamError as raised:
                error = raised
            out[name] = (pcm, [r.request_id for r in retries], error, fake_upstream.calls["tts_log"][mark:])
        fake_upstream.tts_faults.update({"Bom dia!": ["lead"]})
        out["first"] = b"".join([chunk async for chunk in up.speak("Bom dia!", {}, {"voice": "x"}, trim_lead=True)])
        await asyncio.sleep(0.1)
        await up.close()
        await runner.cleanup()
        return out, fake_upstream.calls["tts_active"]

    guard, active = asyncio.run(tts_guard())
    said = fake_upstream.tone(0.5, freq=180.0)
    ids = lambda name: [request["request_id"] for request in guard[name][3]]  # noqa: E731
    check("tts guard: the engine cap is max_new_tokens = (3 s + 0.2 s per character) at 12.5 frames/s",
          guard["lead"][3][0]["max_new_tokens"] == 58 and guard["long"][3][0]["max_new_tokens"] == 438)
    check("tts guard: every attempt carries its own 12-character request id",
          len(set(ids("runaway"))) == 2 and all(len(i) == 12 for i in ids("runaway")))
    check("tts guard: a silent runaway is dropped and the sentence requested again once, heard once",
          guard["runaway"][0] == said and guard["runaway"][1] == ids("runaway")[:1] and guard["runaway"][2] is None)
    check("tts guard: silent again on the retry raises UpstreamError with stage tts, nothing yielded",
          guard["twice"][0] == b"" and len(guard["twice"][3]) == 2 and isinstance(guard["twice"][2], UpstreamError)
          and guard["twice"][2].stage == "tts" and guard["twice"][2].request_id == ids("twice")[1])
    check("tts guard: a stream broken before any audio is requested again once",
          guard["break"][0] == said and len(guard["break"][1]) == 1 and guard["break"][2] is None)
    check("tts guard: a stream broken after audible audio raises, with no retry",
          guard["cut"][0] == said and guard["cut"][1] == [] and len(guard["cut"][3]) == 1
          and isinstance(guard["cut"][2], UpstreamError) and guard["cut"][2].stage == "tts")
    check("tts guard: a silent lead under the limit is kept and not retried",
          guard["lead"][0] == bytes(24000) + said and guard["lead"][1] == [] and len(guard["lead"][3]) == 1)
    check("tts guard: the first sentence of a reply starts 10 ms before its first sound (0.5 s of lead dropped)",
          guard["first"].endswith(said) and len(guard["first"]) - len(said) <= 480)
    check("tts guard: the retry drops its silent lead",
          guard["late"][0].endswith(said) and len(guard["late"][0]) < len(said) + 4800 and len(guard["late"][1]) == 1)
    check("tts guard: no upstream request left open", active == 0)

    async def stage_failures():
        delta = b'data: {"choices": [{"delta": {"content": "oi "}}]}\n\n'
        error_event = b'\n\ndata: {"error": {"message": "chat upstream stalled", "code": "upstream_stalled"}}\n\n'

        async def serve(request):
            mode = (await request.json())["messages"][0]["content"] if "chat" in request.path else (await request.json())["input"]
            res = web.StreamResponse(headers={"Content-Type": "text/event-stream" if "chat" in request.path else "audio/pcm"})
            await res.prepare(request)
            await res.write(delta if "chat" in request.path else b"\0" * 4800)
            if mode == "stall":
                await asyncio.sleep(5)
            if mode == "break":
                request.transport.close()
            if mode == "error":
                await res.write(b'data: {"choi' + error_event)
            if mode == "clean" and "chat" in request.path:
                await res.write(delta + b"data: [DONE]\n\n")
            return res

        app = web.Application()
        app.router.add_post("/v1/chat/completions", serve)
        app.router.add_post("/v1/audio/speech", serve)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        up = Upstream(Settings(upstream=f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}", upstream_gap_s=0.3))
        await up.start()

        async def run(stream):
            got, error, started = [], None, time.monotonic()
            try:
                async for item in stream:
                    got.append(item)
            except Exception as raised:  # noqa: BLE001
                error = raised
            return got, error, time.monotonic() - started

        results = {("llm", mode): await run(up.chat_stream([{"role": "user", "content": mode}], {}))
                   for mode in ("clean", "break", "stall", "error")}
        results.update({("tts", mode): await run(up.speak(mode, {}, {"voice": "x"})) for mode in ("clean", "stall")})
        await up.close()
        await runner.cleanup()
        return results

    stages = asyncio.run(stage_failures())
    failed = lambda stage, mode: (isinstance(stages[stage, mode][1], UpstreamError) and stages[stage, mode][1].stage == stage  # noqa: E731
                                  and stages[stage, mode][1].status is None)
    check("upstream: a clean chat stream yields its deltas and ends", stages["llm", "clean"][:2] == (["oi ", "oi "], None))
    check("upstream: a clean TTS stream yields its audio and ends",
          stages["tts", "clean"][1] is None and sum(map(len, stages["tts", "clean"][0])) == 4800)
    check("upstream: a chat stream cut mid-body raises UpstreamError with stage llm",
          failed("llm", "break") and stages["llm", "break"][0] == ["oi "])
    check("upstream: a chat stream silent for upstream_gap_s raises UpstreamError with stage llm",
          failed("llm", "stall") and stages["llm", "stall"][2] < 2)
    check("upstream: an SSE error event (after a torn line) raises UpstreamError with stage llm and its message",
          failed("llm", "error") and "chat upstream stalled" in str(stages["llm", "error"][1]) and stages["llm", "error"][0] == ["oi "])
    check("upstream: a TTS stream silent for upstream_gap_s raises UpstreamError with stage tts",
          failed("tts", "stall") and stages["tts", "stall"][2] < 2)
    from aioice import Connection

    from aigw_edge import ice as edge_ice

    async def offer_with_dead_turn():
        edge_ice.install(Settings(udp_ports=(50200, 50240), turn_allocate_ms=200))
        conn = Connection(ice_controlling=False, turn_server=("192.0.2.1", 3478), turn_username="u", turn_password="p")
        started = time.monotonic()
        candidates = await conn.get_component_candidates(1, [])
        elapsed = time.monotonic() - started
        await conn.close()
        return [c.type for c in candidates], elapsed

    kinds, elapsed = asyncio.run(offer_with_dead_turn())
    check(f"ice: a TURN server that does not answer costs RT_TURN_ALLOCATE_MS, host candidates still go out ({elapsed:.2f} s)",
          kinds and set(kinds) == {"host"} and elapsed < 1.0)
    check("ice: RT_TURN_ALLOCATE_MS defaults below the SDK's 3 s signalling budget", Settings().turn_allocate_ms == 1500)
    import os

    from aigw_edge.netcheck import NetState

    vast_env = {"RT_UDP_PORTS": "50300-50302", "PUBLIC_IPADDR": "203.0.113.7", "VAST_UDP_PORT_50300": "41000",
                "VAST_UDP_PORT_50301": "41001", "VAST_UDP_PORT_50302": "41002", "VAST_TCP_PORT_80": "41080"}
    os.environ.update(vast_env)
    mapped = Settings.from_env()
    for name in vast_env:
        del os.environ[name]
    edge_ice.install(mapped)
    check("vast: candidates announce PUBLIC_IPADDR and the mapped UDP port",
          edge_ice.announced("172.17.0.2", 50300) == ("203.0.113.7", 41000) and mapped.port_map == {50300: 41000, 50301: 41001, 50302: 41002})
    net = NetState(50302, mapped.public_ip, mapped.public_port(50302))
    check("vast: the probe port reported to the gateway is the mapped one, the responder binds the container port",
          net.view()["probePort"] == 41002 and net.probe_port == 50302 and net.view()["publicIp"] == "203.0.113.7")
    from aigw_edge.server import worker_ranges

    check("vast: the gateway's range (2 ports per session per worker + probe) gives every worker its sessions twice over",
          worker_ranges(50000, 50007, 1) == [(50000, 50007)]
          and [hi - lo + 1 for lo, hi in worker_ranges(50000, 50029, 3)] == [10, 10, 10])
    check("no port map: the probe port is reported as bound", NetState(50100, "").view()["probePort"] == 50100
          and Settings().public_port(50100) == 50100)
except ImportError:
    print("SKIP upstream (no aiohttp)")

try:
    import numpy as np

    from aigw_edge.vad import EnergyVad

    vad = EnergyVad(700)
    noise = (np.random.default_rng(1).standard_normal(320) * 0.002).astype(np.float32)
    tone = (0.2 * np.sin(np.arange(320) / 16000 * 2 * np.pi * 200)).astype(np.float32)
    seq = [vad.push(noise) for _ in range(50)] + [vad.push(tone) for _ in range(30)] + [vad.push(noise) for _ in range(40)]
    check("vad: one start, one end after ~700 ms", [s for s in seq if s] == ["start", "end"]
          and seq.index("end") - 80 in range(34, 37))
    from aigw_edge.audio import Downsampler48to16

    down = Downsampler48to16()
    t48 = np.arange(48000 * 2) / 48000
    for freq, want in ((1000, "kept"), (12000, "removed")):
        sig = (0.5 * 32767 * np.sin(2 * np.pi * freq * t48)).astype(np.int16)
        out = b"".join(down.push(sig[i:i + 960], 1) for i in range(0, len(sig), 960))
        y = np.frombuffer(out, dtype=np.int16).astype(np.float32)[1600:]
        rms = float(np.sqrt(np.mean(y * y))) / (0.5 * 32767 / np.sqrt(2))
        check(f"downsampler 48→16 kHz: {freq} Hz {want} (gain {rms:.2f})", (rms > 0.95) if want == "kept" else (rms < 0.05))
    check("downsampler: 3:1 length", len(down.push(np.zeros(960, dtype=np.int16), 1)) == 320 * 2)

    from aiortc import codecs, rtcrtpreceiver
    from aiortc.jitterbuffer import JitterBuffer
    from aiortc.rtp import RtpPacket
    from aigw_edge import audio

    def through(buffer, order) -> tuple[int, int]:
        behind, frames = 0, 0
        for n in order:
            packet = RtpPacket(sequence_number=n % 65536, timestamp=n * 960)
            packet._data = b"x"
            frame = buffer.add(packet)[1]
            if frame is not None:
                behind, frames = n - frame.timestamp // 960, frames + 1
        return behind, len(order) - frames

    whole, one_lost = list(range(65500, 65700)), [n for n in range(65500, 65700) if n != 65550]
    check("aiortc's audio jitter buffer: 4 frames (80 ms) behind; after one lost packet 14 (280 ms) for the rest of the call",
          through(JitterBuffer(16, 4), whole)[0] == 4 and through(JitterBuffer(16, 4), one_lost)[0] == 14)
    check("webrtc uplink: a packet is a frame as it arrives, before and after a lost packet",
          through(audio.ArrivalOrder(), whole) == (0, 0) and through(audio.ArrivalOrder(), one_lost) == (0, 0))
    check("webrtc uplink: a late or repeated packet is dropped", through(audio.ArrivalOrder(), [7, 9, 8, 9, 10]) == (0, 2))
    audio.install()
    check("webrtc uplink: installed for audio, aiortc's own buffer stays for video",
          isinstance(rtcrtpreceiver.JitterBuffer(capacity=16, prefetch=4), audio.ArrivalOrder)
          and isinstance(rtcrtpreceiver.JitterBuffer(capacity=128, is_video=True), JitterBuffer))
    gaps = audio.GapFill()
    check("webrtc uplink: a gap in the RTP timestamps is the lost audio, counted as elapsed time, at most 1 s of it",
          [gaps.missing(pts, 960) for pts in (0, 960, 2880, 3840, 500000)] == [0, 0, 960, 0, 48000])
    import av
    from aiortc.jitterbuffer import JitterFrame
    from clients import red_payload

    def opus_packets(fec: bool) -> list[bytes]:
        enc = av.CodecContext.create("libopus", "w")
        enc.bit_rate, enc.format, enc.layout, enc.sample_rate = 32000, "s16", "mono", 48000
        enc.options = {"application": "voip", **({"fec": "1", "packet_loss": "10"} if fec else {})}
        voice = (0.3 * 32767 * np.sin(2 * np.pi * 210 * t48[:48000])).astype(np.int16)
        out = []
        for i in range(0, 48000, 960):
            frame = av.AudioFrame.from_ndarray(voice[i:i + 960].reshape(1, -1), format="s16", layout="mono")
            frame.sample_rate, frame.pts = 48000, i
            out += [bytes(packet) for packet in enc.encode(frame)]
        return out

    def heard(packets: list[bytes], lost: set[int], red: bool = False) -> dict:
        decoder = audio.LossDecoder(red)
        frames = [f for n, data in enumerate(packets) if n not in lost for f in decoder.decode(JitterFrame(data=data, timestamp=n * 960))]
        level = lambda f: float(np.sqrt(np.mean(f.to_ndarray().astype(np.float32) ** 2)))  # noqa: E731
        concealed = [f for f in frames if f.opaque[0]]
        return {"contiguous": all(a.pts + a.samples == b.pts for a, b in zip(frames, frames[1:])),
                "samples": sum(f.samples for f in frames), "lost": sum(f.opaque[0] for f in frames),
                "fec": sum(f.opaque[1] for f in frames), "lbrr": sum(f.opaque[2] == audio.FEC for f in frames),
                "voiced": all(level(f) > 0.5 * level(frames[10]) for f in concealed)}

    with_fec, plain = opus_packets(True), opus_packets(False)
    whole, one, two, bare = heard(with_fec, set()), heard(with_fec, {20}), heard(with_fec, {20, 21}), heard(plain, {20})
    check("webrtc uplink loss: nothing lost, nothing concealed; the sender's in-band FEC is seen on its packets",
          whole["lost"] == 0 and whole["contiguous"] and whole["samples"] == len(with_fec) * 960 and whole["lbrr"] >= len(with_fec) // 4)
    check("webrtc uplink loss: one lost packet is rebuilt from the next packet's FEC, in place and not as silence",
          one["lost"] == 960 and one["fec"] == 960 and one["voiced"] and one["contiguous"] and one["samples"] == whole["samples"])
    check("webrtc uplink loss: two lost in a row = the first concealed (PLC), the second from FEC, same elapsed time",
          two["lost"] == 1920 and two["fec"] == 960 and two["voiced"] and two["contiguous"] and two["samples"] == whole["samples"])
    check("webrtc uplink loss: a sender without FEC gets concealment (PLC) instead of silence",
          bare["lost"] == 960 and bare["fec"] == 0 and bare["lbrr"] == 0 and bare["voiced"] and bare["samples"] == whole["samples"])
    red = [red_payload(data, with_fec[n - 1] if n else None, 960, 111) for n, data in enumerate(with_fec)]
    red_whole, red_one, red_two, red_three = (heard(red, lost, True) for lost in (set(), {20}, {20, 21}, {20, 21, 22}))
    check("webrtc uplink RED (RFC 2198): the primary block is the packet, a redundant copy of one already heard is ignored",
          red_whole == {**whole, "lbrr": 0} and audio.red_blocks(red[5]) == [(960, with_fec[4]), (0, with_fec[5])]
          and audio.red_blocks(red[0]) == [(0, with_fec[0])] and audio.red_blocks(b"\x80") == [])
    check("webrtc uplink RED: one lost packet is the copy in the next one; two in a row = FEC inside the copy, then the copy",
          all(r["lost"] == r["fec"] == n * 960 and r["contiguous"] and r["samples"] == whole["samples"] and r["voiced"]
              for n, r in ((1, red_one), (2, red_two))))
    check("webrtc uplink RED: three lost in a row = the first concealed, the other two rebuilt",
          red_three["lost"] == 2880 and red_three["fec"] == 1920 and red_three["contiguous"] and red_three["samples"] == whole["samples"])
    check("webrtc uplink loss: the edge's answer asks the browser for in-band FEC and accepts audio/red",
          codecs.CODECS["audio"][0].parameters.get("useinbandfec") == 1 and audio.is_red(codecs.CODECS["audio"][1])
          and isinstance(rtcrtpreceiver.get_decoder(codecs.CODECS["audio"][0]), audio.LossDecoder)
          and rtcrtpreceiver.get_decoder(codecs.CODECS["audio"][1]).red)
    from aiortc import rtcpeerconnection
    from aiortc.rtcrtpparameters import RTCRtpCodecParameters
    chrome = [RTCRtpCodecParameters(mimeType="audio/red", clockRate=48000, channels=2, payloadType=63, parameters={"111/111": None}),
              RTCRtpCodecParameters(mimeType="audio/opus", clockRate=48000, channels=2, payloadType=111)]
    check("webrtc uplink RED: a browser that offers red first (payload type 63, below 96) is answered red first with its own number and fmtp",
          [(c.mimeType, c.payloadType, c.parameters.get("111/111", 0)) for c in rtcpeerconnection.find_common_codecs(codecs.CODECS["audio"], chrome)]
          == [("audio/red", 63, None), ("audio/opus", 111, 0)])
    doubled = audio.upsample2(np.array([100, 200, -50], dtype=np.int16), 0)
    check("webrtc downlink: 24 kHz PCM leaves at 48 kHz, each sample kept and the one between interpolated across frames",
          doubled.tolist() == [50, 100, 150, 200, 75, -50] and doubled.dtype == np.int16
          and audio.upsample2(np.array([10], dtype=np.int16), -50).tolist() == [-20, 10])
    from aigw_edge.session import AudioOut
    out = AudioOut()
    idle = out.pacing()
    out.push(bytes(1920))
    out.mark()
    out.sent(0.5)
    out.pull(960)
    out.sent(0.004)
    out.sent(0.002)
    paced = out.pacing()
    check("webrtc downlink: per reply, when its first frame left and how late the packets after it were sent",
          idle == {} and paced["rtp_late_max_ms"] == 4.0 and paced["rtp_late_p50_ms"] == 4.0
          and paced["rtp_first_sent_ms"] == round(paced["out_first_pull_ms"] + 4.0, 1) and 0 <= paced["out_first_pull_ms"] < 50)
except ImportError:
    print("SKIP vad (no numpy)")

sys.exit(1 if failures else 0)
