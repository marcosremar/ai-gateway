"""
ICE host candidates for a server in a cloud: aiortc (aioice) binds one random UDP port per local address and offers the
local address. A GPU replica needs instead:

  - ports from a fixed range (`RT_UDP_PORTS`, the range its firewall opens: Scaleway security group, Vast `-p`);
  - one bind address (`RT_UDP_BIND`; default every non-loopback IPv4, like aioice), IPv4 only;
  - the address the browser can reach announced in the SDP (`RT_PUBLIC_IP`; Vast: `PUBLIC_IPADDR`) and, where the
    provider remaps ports (Vast: `VAST_UDP_PORT_<n>`), the public port — the mediasoup "announced IP" model.

No STUN/TURN on the server side: the replica has a public address, and a browser behind a strict NAT relays through the
TURN deployment (the `coturn` profile) from its own side. `install()` patches aioice once at startup.
"""

import asyncio
import random

from aioice import ice
from aioice.candidate import Candidate, candidate_foundation, candidate_priority

_settings = None


def bind_addresses() -> list[str]:
    if _settings and _settings.udp_bind:
        return [a.strip() for a in _settings.udp_bind.split(",") if a.strip()]
    return [a for a in ice.get_host_addresses(use_ipv4=True, use_ipv6=False)] or ["0.0.0.0"]


def announced(host: str, port: int) -> tuple[str, int]:
    s = _settings
    if not s:
        return host, port
    return (s.public_ip or host), s.port_map.get(port, port)


async def _bind_in_range(loop, factory, address: str):
    lo, hi = _settings.udp_ports
    ports = list(range(lo, hi + 1))
    random.shuffle(ports)
    last = None
    for port in ports:
        try:
            return await loop.create_datagram_endpoint(factory, local_addr=(address, port))
        except OSError as error:
            last = error
    raise OSError(f"no free UDP port in {lo}-{hi} on {address}: {last}")


async def _get_component_candidates(self, component: int, addresses: list[str], timeout: int = 5) -> list[Candidate]:
    loop = asyncio.get_running_loop()
    candidates = []
    for address in bind_addresses():
        transport, protocol = await _bind_in_range(loop, lambda: ice.StunProtocol(self), address)
        host, port = transport.get_extra_info("sockname")[:2]
        public_host, public_port = announced(host, port)
        protocol.local_candidate = Candidate(
            foundation=candidate_foundation("host", "udp", public_host), component=component, transport="udp",
            priority=candidate_priority(component, "host"), host=public_host, port=public_port, type="host",
        )
        self._protocols.append(protocol)
        candidates.append(protocol.local_candidate)
    return candidates


def install(settings) -> None:
    global _settings
    _settings = settings
    ice.Connection.get_component_candidates = _get_component_candidates
