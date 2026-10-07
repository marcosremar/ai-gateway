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
    body = src[src.index("SENTENCE_END ="):src.index("async def llm_stream")].rstrip()
    check("text.py = speech-stack server.py cut/JsonField", body in (ROOT / "aigw_edge" / "text.py").read_text())


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

try:
    import asyncio

    from aiohttp import web

    from aigw_edge.config import Settings
    from aigw_edge.upstream import Upstream, UpstreamError

    async def cut_tts_stream():
        async def speech(request):
            res = web.StreamResponse()
            await res.prepare(request)
            await res.write(b"\0" * 4800)
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
    check("upstream: a TTS stream cut mid-body raises UpstreamError with stage tts",
          got == 4800 and isinstance(error, UpstreamError) and error.stage == "tts" and error.status is None)
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
except ImportError:
    print("SKIP vad (no numpy)")

sys.exit(1 if failures else 0)
