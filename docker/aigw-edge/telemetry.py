"""Edge telemetry emitter for the ai-gateway (docs/api/telemetry.md). Stdlib only: copy or import it.

Batches events to ``POST <gateway>/v1/telemetry/events`` authenticated as the replica::

    Authorization: Bearer <hex HMAC-SHA256(key=replica_token, msg="aigw-telemetry-v1")>
    X-Aigw-Replica: <replica id>

The gateway verifies the signature with the deployment's replica token and stamps ``deployment`` / ``replicaId``
itself. ``replica_token`` is the same secret the replica's front proxy checks (``X-Aigw-Token``).

    from telemetry import TelemetryEmitter
    tel = TelemetryEmitter(gateway_url, replica_id, replica_token)
    tel.emit("vad.segment", trace_id=tid, session_id=sid, turn_id=turn, dur_ms=840, attrs={"speechMs": 790})
    tel.close()

Batching: flush every ``flush_interval`` s (5) or at ``max_batch`` (50) events; bounded queue (``max_queue``, 1000)
dropping the oldest and reporting the count as one ``telemetry.dropped`` event. Transient failures (network, 429,
5xx) keep the batch for the next try; other 4xx drop it. Never raises into the caller.

Privacy: codes, counts, lengths and durations only — never audio, transcripts, LLM text, keys or IPs.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Any, Callable, Deque, Dict, Optional

HMAC_INFO = b"aigw-telemetry-v1"
INGEST_PATH = "/v1/telemetry/events"
MAX_BATCH_EVENTS = 100
MAX_BATCH_BYTES = 64 * 1024
MAX_ATTRS = 32
MAX_ATTR_STRING = 200
LEVELS = ("debug", "info", "warn", "error")
EVENT_NAME = re.compile(r"^[a-z0-9_]+(\.[a-z0-9_-]+)+$")
TRACE_ID = re.compile(r"^(?!0{32})[0-9a-f]{32}$")
TRACEPARENT = re.compile(r"^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$")


def edge_signature(replica_token: str) -> str:
    """hex(HMAC-SHA256(key=replica_token, msg="aigw-telemetry-v1"))."""
    return hmac.new(replica_token.encode("utf-8"), HMAC_INFO, hashlib.sha256).hexdigest()


def new_trace_id() -> str:
    while True:
        tid = os.urandom(16).hex()
        if TRACE_ID.match(tid):
            return tid


def trace_id_from_traceparent(value: Optional[str]) -> Optional[str]:
    """Trace id of a W3C ``traceparent`` header (what the gateway sends to the replica), or None."""
    m = TRACEPARENT.match((value or "").strip().lower())
    return m.group(1) if m and TRACE_ID.match(m.group(1)) else None


def _clean_attrs(attrs: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not attrs:
        return None
    out: Dict[str, Any] = {}
    for k, v in attrs.items():
        if len(out) >= MAX_ATTRS:
            break
        if v is None or isinstance(v, bool):
            out[str(k)] = v
        elif isinstance(v, (int, float)):
            if v == v and v not in (float("inf"), float("-inf")):
                out[str(k)] = v
        elif isinstance(v, str) and len(v) <= MAX_ATTR_STRING:
            out[str(k)] = v
    return out or None


Opener = Callable[[urllib.request.Request, float], Any]


class TelemetryEmitter:
    def __init__(
        self,
        gateway_url: str,
        replica_id: str,
        replica_token: str,
        *,
        source: str = "edge",
        flush_interval: float = 5.0,
        max_batch: int = 50,
        max_queue: int = 1000,
        timeout: float = 5.0,
        opener: Optional[Opener] = None,
        start_thread: bool = True,
    ) -> None:
        base = gateway_url.rstrip("/")
        self.url = base if base.endswith(INGEST_PATH) else base + INGEST_PATH
        self.replica_id = replica_id
        self._auth = edge_signature(replica_token)
        self.source = source if source in ("edge", "model") else "edge"
        self.max_batch = max(1, min(max_batch, MAX_BATCH_EVENTS))
        self.max_queue = max(1, max_queue)
        self.timeout = timeout
        self._open = opener or (lambda req, t: urllib.request.urlopen(req, timeout=t))  # noqa: S310 (gateway URL)
        self._queue: Deque[Dict[str, Any]] = deque()
        self._lock = threading.Lock()
        self._flush_lock = threading.Lock()
        self._stop = threading.Event()
        self._dropped_pending = 0
        self.stats = {"sent": 0, "dropped": 0, "failed": 0}
        self._thread: Optional[threading.Thread] = None
        if start_thread:
            self._thread = threading.Thread(target=self._run, args=(flush_interval,), name="aigw-telemetry", daemon=True)
            self._thread.start()

    # ── public API (never raises) ────────────────────────────────────────────
    def emit(
        self,
        event: str,
        *,
        level: str = "info",
        trace_id: Optional[str] = None,
        session_id: Optional[str] = None,
        turn_id: Optional[str] = None,
        dur_ms: Optional[float] = None,
        attrs: Optional[Dict[str, Any]] = None,
        source: Optional[str] = None,
    ) -> None:
        try:
            if not EVENT_NAME.match(event) or len(event) > 64:
                return
            e: Dict[str, Any] = {
                "ts": int(time.time() * 1000),
                "source": source if source in ("edge", "model") else self.source,
                "level": level if level in LEVELS else "info",
                "event": event,
                "traceId": trace_id if trace_id and TRACE_ID.match(trace_id) else new_trace_id(),
            }
            if session_id:
                e["sessionId"] = str(session_id)[:128]
            if turn_id:
                e["turnId"] = str(turn_id)[:128]
            if dur_ms is not None and dur_ms >= 0:
                e["durMs"] = int(round(dur_ms))
            clean = _clean_attrs(attrs)
            if clean:
                e["attrs"] = clean
            with self._lock:
                self._push(e)
                full = len(self._queue) >= self.max_batch
            if full and self._thread is not None:
                threading.Thread(target=self.flush, daemon=True).start()
        except Exception:  # noqa: BLE001 — telemetry never breaks the caller
            pass

    def flush(self) -> None:
        """Sends what is queued (blocking, one batch at a time)."""
        try:
            with self._flush_lock:
                self._add_drop_notice()
                while True:
                    batch = self._take_batch()
                    if not batch:
                        return
                    outcome = self._post(batch)
                    if outcome == "retry":
                        with self._lock:
                            for e in reversed(batch):
                                self._queue.appendleft(e)
                            self._trim()
                        return
        except Exception:  # noqa: BLE001
            pass

    def close(self) -> None:
        self._stop.set()
        self.flush()

    # ── internals ────────────────────────────────────────────────────────────
    def _push(self, e: Dict[str, Any]) -> None:
        self._queue.append(e)
        self._trim()

    def _trim(self) -> None:
        while len(self._queue) > self.max_queue:
            self._queue.popleft()
            self.stats["dropped"] += 1
            self._dropped_pending += 1

    def _add_drop_notice(self) -> None:
        with self._lock:
            if not self._dropped_pending:
                return
            count, self._dropped_pending = self._dropped_pending, 0
            self._queue.appendleft({
                "ts": int(time.time() * 1000), "source": self.source, "level": "warn", "event": "telemetry.dropped",
                "traceId": new_trace_id(), "attrs": {"count": count},
            })

    def _take_batch(self) -> list:
        batch: list = []
        size = 0
        with self._lock:
            while self._queue and len(batch) < self.max_batch:
                n = len(json.dumps(self._queue[0], separators=(",", ":"))) + 1
                if batch and size + n > MAX_BATCH_BYTES - 1024:
                    break
                size += n
                batch.append(self._queue.popleft())
        return batch

    def _post(self, batch: list) -> str:
        body = json.dumps({"events": batch}, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(self.url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + self._auth,
            "X-Aigw-Replica": self.replica_id,
        })
        try:
            resp = self._open(req, self.timeout)
            try:
                resp.read()
            finally:
                close = getattr(resp, "close", None)
                if close:
                    close()
            self.stats["sent"] += len(batch)
            return "ok"
        except urllib.error.HTTPError as err:
            if err.code == 429 or err.code >= 500:
                return "retry"
            self.stats["failed"] += len(batch)
            return "dropped"
        except Exception:  # noqa: BLE001 — network: keep the batch for the next try
            return "retry"

    def _run(self, interval: float) -> None:
        while not self._stop.wait(interval):
            self.flush()
