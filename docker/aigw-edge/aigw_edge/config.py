"""
Edge settings, all from the environment (the gateway's cloud-init writes them; see docs/realtime-edge.md).

The edge is a generic sidecar: it knows nothing of the model container but its HTTP base URL (`EDGE_UPSTREAM`) and the
OpenAI-shaped routes every speech replica serves (`/v1/audio/transcriptions`, `/v1/chat/completions`,
`/v1/audio/speech`, optionally `/ws/audio-stream` for partial transcripts and `/v1/s2s`).
"""

import hashlib
import hmac
import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _ports(raw: str) -> tuple[int, int]:
    lo, _, hi = raw.partition("-")
    lo_n, hi_n = int(lo), int(hi or lo)
    if not (1024 <= lo_n <= hi_n <= 65535):
        raise ValueError(f"RT_UDP_PORTS must be lo-hi within 1024-65535 (got {raw!r})")
    return lo_n, hi_n


MAX_FIRST_AUDIO_DEADLINE_MS = 2500


def derive_key(replica_token: str) -> bytes:
    """The shared contract: signing key = HMAC-SHA256(key=replicaToken, msg="aigw-rt-v1")."""
    return hmac.new(replica_token.encode(), b"aigw-rt-v1", hashlib.sha256).digest()


@dataclass
class Settings:
    upstream: str = "http://127.0.0.1:8000"
    upstream_health: str = "/health"
    upstream_gap_s: float = 10.0
    # stages = STT → LLM → TTS over the three OpenAI routes; s2s = the replica's own /v1/s2s (one call per turn).
    upstream_mode: str = "stages"
    bind: str = "127.0.0.1"
    port: int = 8020
    max_sessions: int = 8
    rtc_workers: int = 0
    udp_ports: tuple[int, int] = (50000, 50100)
    # The last port of RT_UDP_PORTS answers the gateway's reachability probe (netcheck.py); media uses the rest.
    probe_port: int = 0
    udp_bind: str = ""
    public_ip: str = ""
    port_map: dict[int, int] = field(default_factory=dict)
    turn_allocate_ms: int = 1500
    replica_id: str = ""
    deployment: str = ""
    key: bytes = b""
    max_session_seconds: int = 900
    max_turn_seconds: int = 60
    idle_seconds: int = 120
    vad_silence_ms: int = 700
    speculate_ms: int = 300
    stt_partials: bool = False
    llm_model: str = "llm"
    tts_model: str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    tts_rate: int = 24000
    tts_parallel: int = 2
    tts_max_seconds: float = 3.0
    tts_max_seconds_per_char: float = 0.2
    tts_max_lead_seconds: float = 1.0
    first_audio_deadline_ms: int = 2000
    first_audio_margin_ms: int = 300
    shed_window_s: int = 30
    # Where the TTS server fetches a catalog voice's reference audio (speech-stack: its own /refs/<id>.wav).
    ref_base: str = ""

    def public_port(self, port: int) -> int:
        return self.port_map.get(port, port)

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ
        token = env.get("AIGW_REPLICA_TOKEN", "")
        key = derive_key(token) if token else bytes.fromhex(env.get("AIGW_RT_KEY", ""))
        # Vast publishes each container port on a random host port and says which in VAST_UDP_PORT_<n>.
        port_map = {int(k[len("VAST_UDP_PORT_"):]): int(v) for k, v in env.items()
                    if k.startswith("VAST_UDP_PORT_") and k[len("VAST_UDP_PORT_"):].isdigit() and v.isdigit()}
        upstream = env.get("EDGE_UPSTREAM", "http://127.0.0.1:8000").rstrip("/")
        max_sessions = max(0, _int("RT_MAX_SESSIONS", 8))
        # aiortc runs every packet in Python on one loop: ~7-9 % of a core per WebRTC session (docs/realtime-edge.md),
        # so RT_SESSIONS_PER_WORKER sessions per worker process keep each loop well under one core.
        per_worker = max(1, _int("RT_SESSIONS_PER_WORKER", 6))
        rtc_workers = _int("RT_RTC_WORKERS", -(-max_sessions // per_worker) if max_sessions else 0)
        return cls(
            upstream=upstream,
            upstream_health=env.get("EDGE_UPSTREAM_HEALTH", "/health"),
            upstream_gap_s=float(env.get("EDGE_UPSTREAM_GAP_S", "10")),
            upstream_mode=env.get("EDGE_UPSTREAM_MODE", "stages"),
            bind=env.get("RT_BIND", "127.0.0.1"),
            port=_int("RT_PORT", 8020),
            max_sessions=max_sessions,
            rtc_workers=max(0, rtc_workers),
            udp_ports=_ports(env.get("RT_UDP_PORTS", "50000-50100")),
            udp_bind=env.get("RT_UDP_BIND", ""),
            public_ip=env.get("RT_PUBLIC_IP") or env.get("PUBLIC_IPADDR", ""),
            port_map=port_map,
            turn_allocate_ms=max(100, _int("RT_TURN_ALLOCATE_MS", 1500)),
            replica_id=env.get("AIGW_REPLICA_ID") or env.get("CONTAINER_ID", ""),
            deployment=env.get("AIGW_DEPLOYMENT", ""),
            key=key,
            max_session_seconds=_int("RT_MAX_SESSION_SECONDS", 900),
            max_turn_seconds=_int("RT_MAX_TURN_SECONDS", 60),
            idle_seconds=_int("RT_IDLE_SECONDS", 120),
            vad_silence_ms=_int("RT_VAD_SILENCE_MS", 700),
            speculate_ms=max(0, _int("EDGE_SPECULATE_MS", 300)),
            stt_partials=env.get("EDGE_STT_PARTIALS") == "1",
            llm_model=env.get("EDGE_LLM_MODEL", "llm"),
            tts_model=env.get("EDGE_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base"),
            tts_rate=_int("EDGE_TTS_RATE", 24000),
            tts_parallel=max(1, _int("EDGE_TTS_PARALLEL", 2)),
            tts_max_seconds=float(env.get("EDGE_TTS_MAX_SECONDS", "3")),
            tts_max_seconds_per_char=float(env.get("EDGE_TTS_MAX_SECONDS_PER_CHAR", "0.2")),
            tts_max_lead_seconds=float(env.get("EDGE_TTS_MAX_LEAD_SECONDS", "1")),
            first_audio_deadline_ms=min(MAX_FIRST_AUDIO_DEADLINE_MS, max(1, _int("RT_FIRST_AUDIO_DEADLINE_MS", 2000))),
            first_audio_margin_ms=max(0, _int("RT_FIRST_AUDIO_MARGIN_MS", 300)),
            shed_window_s=max(0, _int("RT_SHED_WINDOW_S", 30)),
            ref_base=env.get("EDGE_REF_BASE", upstream).rstrip("/"),
        )
