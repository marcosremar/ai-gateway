"""
The edge's telemetry, on the shared stdlib emitter `docker/aigw-edge/telemetry.py` (`TelemetryEmitter`, owned by the
gateway's telemetry work — not edited here): correlated events to `POST {GATEWAY_URL}/v1/telemetry/events`, signed with
hex HMAC-SHA256(replicaToken, "aigw-telemetry-v1") + `X-Aigw-Replica: AIGW_REPLICA_ID`; the gateway stamps replicaId /
deployment / app. This module adds what the edge needs around it:

  - one process-wide `telemetry` built from the environment (GATEWAY_URL, AIGW_REPLICA_ID, AIGW_REPLICA_TOKEN);
  - every event also printed as one JSON line on stdout (EDGE_TELEMETRY_STDOUT=0 turns it off), so the events exist
    in `docker logs` with no network, or with no GATEWAY_URL at all;
  - `emit(event, **attrs)`: keyword attributes (scalars: lengths, codes, durations — never audio, transcript, LLM text
    or tokens), and the W3C trace helpers.
"""

import json
import os
import secrets
import sys
import time

from telemetry import TelemetryEmitter, new_trace_id, trace_id_from_traceparent  # docker/aigw-edge/telemetry.py

__all__ = ["telemetry", "new_trace_id", "trace_id_from", "child_traceparent"]


def trace_id_from(traceparent: str | None) -> str | None:
    return trace_id_from_traceparent(traceparent)


def child_traceparent(trace_id: str) -> str:
    """A traceparent for an outgoing call in this trace (same trace, new span id)."""
    return f"00-{trace_id}-{secrets.token_hex(8)}-01"


class EdgeTelemetry:
    def __init__(self, gateway_url: str, replica_id: str, replica_token: str, stdout: bool = True):
        self.stdout = stdout
        self.emitter = TelemetryEmitter(gateway_url, replica_id, replica_token) \
            if gateway_url and replica_id and replica_token else None
        self.process_trace = new_trace_id()

    @classmethod
    def from_env(cls) -> "EdgeTelemetry":
        env = os.environ
        return cls(env.get("GATEWAY_URL", ""), env.get("AIGW_REPLICA_ID") or env.get("CONTAINER_ID", ""),
                   env.get("AIGW_REPLICA_TOKEN", ""), env.get("EDGE_TELEMETRY_STDOUT", "1") != "0")

    def emit(self, event: str, *, trace_id: str | None = None, session_id: str | None = None, turn_id: str | None = None,
             dur_ms: float | None = None, level: str = "info", source: str = "edge", **attrs) -> None:
        try:
            trace = trace_id or self.process_trace
            if self.stdout:
                line = {"ts": int(time.time() * 1000), "source": source, "level": level, "event": event, "traceId": trace}
                if session_id:
                    line["sessionId"] = session_id
                if turn_id:
                    line["turnId"] = turn_id
                if dur_ms is not None:
                    line["durMs"] = max(0, round(dur_ms))
                if attrs:
                    line["attrs"] = attrs
                sys.stdout.write(json.dumps(line, separators=(",", ":")) + "\n")
                sys.stdout.flush()
            if self.emitter is not None:
                self.emitter.emit(event, level=level, trace_id=trace, session_id=session_id, turn_id=turn_id,
                                  dur_ms=dur_ms, attrs=attrs or None, source=source)
        except Exception:  # noqa: BLE001 — telemetry never breaks the media path
            pass

    def flush(self) -> None:
        if self.emitter is not None:
            self.emitter.flush()


telemetry = EdgeTelemetry.from_env()
