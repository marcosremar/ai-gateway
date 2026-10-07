"""
How a learner's media can reach this replica, checked instead of assumed (docs/realtime-edge.md § Reachability).
Fastest path first:

  direct  inbound UDP into RT_UDP_PORTS works (the gateway's echo probe came back): ICE host candidates, one hop.
  relay   inbound UDP is blocked (provider firewall, NAT without the port mapping) but the edge reaches the TURN server
          OUTBOUND — UDP, then TCP, then TLS — so it allocates a relay itself and media flows with no inbound port
          open. One extra hop through the TURN server.
  ws      neither: WebRTC is not offered at all (the learner does not lose ~5 s on a doomed ICE check) and sessions go
          straight to the WebSocket through the gateway — the reverse-proxy path, the slowest realtime rung, kept last.

`unknown` (before the gateway's first probe) offers WebRTC as before. Every check and every decision is logged with its
reasons (`edge.net.*` telemetry and stdout) and shown in `GET /__aigw/rt/status` → `net`.

The probe responder answers `AIGWP1<nonce>` with `AIGWR1<nonce>` on the last port of the range: same size as the
request (no amplification), at most 64 bytes, nothing else answered.
"""

import asyncio
import re
import ssl
import time

from aioice.turn import create_turn_endpoint

from .telemetry import telemetry

PROBE_MAGIC, REPLY_MAGIC = b"AIGWP1", b"AIGWR1"
RELAY_TIMEOUT_S = 4.0
TURN_URL = re.compile(r"^(turns?):([^:?\s]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$")


class ProbeResponder(asyncio.DatagramProtocol):
    def __init__(self) -> None:
        self.transport = None
        self.hits = 0

    def connection_made(self, transport) -> None:
        self.transport = transport

    def datagram_received(self, data: bytes, addr) -> None:
        if data.startswith(PROBE_MAGIC) and len(data) <= 64:
            self.hits += 1
            self.transport.sendto(REPLY_MAGIC + data[len(PROBE_MAGIC):], addr)


def parse_turn(url: str) -> dict | None:
    m = TURN_URL.match(url.strip())
    if not m:
        return None
    scheme, host, port, transport = m.groups()
    return {"url": url, "host": host, "port": int(port or (5349 if scheme == "turns" else 3478)),
            "transport": transport or ("tcp" if scheme == "turns" else "udp"), "tls": scheme == "turns"}


def relay_order(servers: list[dict]) -> list[dict]:
    """Each TURN URL with its credentials, fastest transport first: UDP, then TCP, then TLS (443 gets through most)."""
    out = []
    for server in servers:
        urls = server.get("urls")
        for url in [urls] if isinstance(urls, str) else (urls or []):
            parsed = parse_turn(str(url))
            if parsed:
                out.append({**parsed, "username": server.get("username"), "credential": server.get("credential")})
    return sorted(out, key=lambda t: (t["tls"], t["transport"] != "udp"))


async def try_relay(t: dict) -> tuple[bool, str, float]:
    started = time.monotonic()
    ctx = ssl.create_default_context() if t["tls"] else None
    try:
        transport, _ = await asyncio.wait_for(create_turn_endpoint(
            asyncio.DatagramProtocol, server_addr=(t["host"], t["port"]), username=t["username"],
            password=t["credential"], ssl=ctx, transport=t["transport"]), RELAY_TIMEOUT_S)
        relayed = transport.get_extra_info("sockname")
        transport.close()
        return True, f"allocated {relayed[0]}:{relayed[1]}", (time.monotonic() - started) * 1000
    except Exception as error:  # noqa: BLE001 — every failure is one reason in the log
        return False, f"{type(error).__name__}: {error}"[:160], (time.monotonic() - started) * 1000


class NetState:
    def __init__(self, probe_port: int, public_ip: str) -> None:
        self.probe_port, self.public_ip = probe_port, public_ip
        self.udp_inbound = "unknown"
        self.path = "unknown"
        self.relay: dict | None = None
        self.reasons: list[str] = []
        self.checked_at: float | None = None
        self.responder: ProbeResponder | None = None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        try:
            _, self.responder = await loop.create_datagram_endpoint(ProbeResponder, local_addr=("0.0.0.0", self.probe_port))
            note = f"probe responder on udp/{self.probe_port}"
        except OSError as error:
            note = f"probe responder could not bind udp/{self.probe_port}: {error}"
        print(f"[edge] net: {note}; public={self.public_ip or '-'}; path unknown until the gateway probes", flush=True)
        telemetry.emit("edge.net.boot", probePort=self.probe_port, responder=self.responder is not None,
                       publicIp=bool(self.public_ip))

    def transports(self) -> list[str]:
        return ["ws"] if self.path == "ws" else ["webrtc", "ws"]

    def ice_servers(self, fresh: list[dict] | None = None) -> list[dict]:
        """The TURN server the edge itself uses on `relay` (aiortc takes one): the URL whose allocation worked, with the
        session's own credentials when the offer carries them (the probe's expire), else the probe's."""
        r = self.relay
        if self.path != "relay" or not r:
            return []
        for server in fresh or []:
            urls = server.get("urls")
            if r["url"] in ([urls] if isinstance(urls, str) else (urls or [])):
                return [{"urls": r["url"], "username": server.get("username"), "credential": server.get("credential")}]
        return [{"urls": r["url"], "username": r["username"], "credential": r["credential"]}]

    def view(self) -> dict:
        return {
            "path": self.path, "udpInbound": self.udp_inbound, "probePort": self.probe_port, "publicIp": self.public_ip or None,
            "probeHits": self.responder.hits if self.responder else 0,
            "relay": {k: self.relay[k] for k in ("url", "transport", "ms")} if self.relay else None,
            "reasons": self.reasons, "checkedAt": self.checked_at,
        }

    async def report(self, udp_inbound: str, turn_servers: list[dict], rtt_ms: float | None, trace_id: str) -> dict:
        """The gateway's probe result (and short-lived TURN credentials to test with): decides and logs the path."""
        reasons = [f"inbound udp/{self.probe_port}: {udp_inbound}" + (f" ({rtt_ms:.0f} ms)" if rtt_ms is not None else "")]
        self.udp_inbound = udp_inbound if udp_inbound in ("ok", "blocked") else "unknown"
        relay = None
        if self.udp_inbound == "ok":
            path = "direct"
        else:
            candidates = relay_order(turn_servers)
            if not candidates:
                reasons.append("no TURN server configured (REALTIME_TURN_URLS/REALTIME_TURN_SECRET on the gateway)")
            for t in candidates:
                ok, detail, ms = await try_relay(t)
                reasons.append(f"relay {t['url']}: {detail} ({ms:.0f} ms)")
                telemetry.emit("edge.net.relay_try", trace_id=trace_id, level="info" if ok else "warn", url=t["url"],
                               transport=t["transport"], tls=t["tls"], ok=ok, dur_ms=ms)
                if ok:
                    relay = {**t, "ms": round(ms)}
                    break
            path = "relay" if relay else "ws"
        changed = path != self.path
        self.path, self.relay, self.reasons, self.checked_at = path, relay, reasons, time.time()
        print(f"[edge] net: path={path} — " + "; ".join(reasons), flush=True)
        telemetry.emit("edge.net.path", trace_id=trace_id, level="warn" if path == "ws" else "info", path=path,
                       udpInbound=self.udp_inbound, relay=relay["url"] if relay else None, changed=changed,
                       reasons=" | ".join(reasons)[:190])  # the gateway drops strings over 200 chars (free text)
        return self.view()
